import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Logger, MINUTE_MS } from '@agentmesh/common';
import type { IngestSource } from '@agentmesh/config';
import { header, verifyIngestAuth } from './auth';
import { type IdentifiedEvent, normalizeEvent } from './normalize';

export interface IngestHttpOptions {
  host: string;
  port: number;
  sources: readonly IngestSource[];
  /** Where accepted events go (NATS in production, the service directly in tests). */
  sink(source: string, event: IdentifiedEvent): Promise<{ duplicate: boolean }>;
  logger: Logger;
  maxBodyBytes?: number;
}

const MAX_BODY = 1024 * 1024;
const ROUTE = /^\/v1\/ingest\/([a-z0-9][a-z0-9-]{0,62})\/?$/;
/** Webhook senders send a small body at once: a slow or idle client must not hold a socket. */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 100;
const NO_BODY = Buffer.alloc(0);

/**
 * The hub's HTTP surface: `GET /healthz` and `POST /v1/ingest/{source}`.
 * Responses never echo request contents or secrets.
 */
export async function startIngestServer(options: IngestHttpOptions): Promise<Server> {
  const authFailed = authFailureLog(options.logger);
  const server = createServer((req, res) => {
    handle(req, res, options, authFailed).catch((err) => {
      options.logger.error({ err }, 'ingest request failed');
      send(res, 500, { error: 'internal error' });
    });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  options.logger.info({ host: address.address, port: address.port }, 'hub http listening');
  return server;
}

export function closeServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Logs failed ingest auth at most once a minute per source, with how many failures the line
 * stands for, so a flood of bad requests cannot flood the log. Sources come from config.
 */
export function authFailureLog(
  logger: Logger,
  now: () => number = Date.now,
): (source: string) => void {
  const last = new Map<string, { at: number; quiet: number }>();
  return (source) => {
    const entry = last.get(source);
    if (entry && now() - entry.at < MINUTE_MS) {
      entry.quiet += 1;
      return;
    }
    logger.warn({ source, failures: (entry?.quiet ?? 0) + 1 }, 'ingest auth failed');
    last.set(source, { at: now(), quiet: 0 });
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: IngestHttpOptions,
  authFailed: (source: string) => void,
): Promise<void> {
  const source = resolveSource(req, res, options);
  if (!source) return;
  const unauthorized = () => {
    authFailed(source.id);
    refuse(res, 401, 'unauthorized');
  };
  // A bearer token is checked before any of the body is read; an HMAC signs the body.
  const signed = source.auth.type === 'hmac-sha256';
  if (!signed && !verifyIngestAuth(source.auth, req.headers, NO_BODY)) return unauthorized();
  const limit = options.maxBodyBytes ?? MAX_BODY;
  if (Number(req.headers['content-length'] ?? 0) > limit) return refuse(res, 413, 'body too large');
  const raw = await readBody(req, limit);
  if (raw === null) return refuse(res, 413, 'body too large');
  if (signed && !verifyIngestAuth(source.auth, req.headers, raw)) return unauthorized();
  const normalized = normalizeEvent(source, req.headers, raw);
  if (!normalized.ok) {
    return send(res, 400, {
      error: normalized.error,
      ...(normalized.issues ? { issues: normalized.issues } : {}),
    });
  }
  try {
    const result = await options.sink(source.id, normalized.event);
    const delivery = source.idHeader ? header(req.headers, source.idHeader)?.slice(0, 100) : null;
    options.logger.info(
      { source: source.id, type: normalized.event.type, id: normalized.event.id, delivery },
      'event ingested',
    );
    send(res, 202, { id: normalized.event.id, duplicate: result.duplicate });
  } catch (err) {
    options.logger.error({ err, source: source.id }, 'ingest sink unavailable');
    send(res, 503, { error: 'temporarily unavailable' });
  }
}

/** The configured source a POST names, or null once the request was answered. */
function resolveSource(
  req: IncomingMessage,
  res: ServerResponse,
  options: IngestHttpOptions,
): IngestSource | null {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (req.method === 'GET' && path === '/healthz') {
    send(res, 200, { ok: true });
    return null;
  }
  const route = ROUTE.exec(path);
  const source = route && options.sources.find((s) => s.id === route[1]);
  if (!route) refuse(res, 404, 'not found');
  else if (req.method !== 'POST') refuse(res, 405, 'use POST');
  else if (!source) refuse(res, 404, 'unknown source');
  else return source;
  return null;
}

/** Resolves to null as soon as the body exceeds `limit`; the rest is never buffered. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      req.off('data', onData);
      resolve(null);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Answers a request whose body the hub will not read, and closes the connection: Node then
 * destroys the socket once the answer is out, instead of draining an unwanted body.
 */
function refuse(res: ServerResponse, status: number, error: string): void {
  res.setHeader('connection', 'close');
  send(res, status, { error });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
