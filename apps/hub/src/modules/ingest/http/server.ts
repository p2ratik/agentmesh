import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@agentmesh/common';
import type { IngestSource } from '@agentmesh/config';
import { verifyIngestAuth } from './auth';
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

/**
 * The hub's HTTP surface: `GET /healthz` and `POST /v1/ingest/{source}`.
 * Responses never echo request contents or secrets.
 */
export async function startIngestServer(options: IngestHttpOptions): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req, res, options).catch((err) => {
      options.logger.error({ err }, 'ingest request failed');
      send(res, 500, { error: 'internal error' });
    });
  });
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

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: IngestHttpOptions,
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
  const route = ROUTE.exec(path);
  if (!route) return send(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });

  const source = options.sources.find((s) => s.id === route[1]);
  if (!source) return send(res, 404, { error: 'unknown source' });
  const raw = await readBody(req, options.maxBodyBytes ?? MAX_BODY);
  if (raw === null) return send(res, 413, { error: 'body too large' });
  if (!verifyIngestAuth(source.auth, req.headers, raw)) {
    options.logger.warn({ source: source.id }, 'ingest auth failed');
    return send(res, 401, { error: 'unauthorized' });
  }
  const normalized = normalizeEvent(source, req.headers, raw);
  if (!normalized.ok) {
    return send(res, 400, {
      error: normalized.error,
      ...(normalized.issues ? { issues: normalized.issues } : {}),
    });
  }
  try {
    const result = await options.sink(source.id, normalized.event);
    options.logger.info(
      { source: source.id, type: normalized.event.type, id: normalized.event.id },
      'event ingested',
    );
    send(res, 202, { id: normalized.event.id, duplicate: result.duplicate });
  } catch (err) {
    options.logger.error({ err, source: source.id }, 'ingest sink unavailable');
    send(res, 503, { error: 'temporarily unavailable' });
  }
}

/** Resolves to null once the body exceeds `limit` (the rest is drained and dropped). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
