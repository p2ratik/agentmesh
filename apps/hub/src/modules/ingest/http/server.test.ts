import { createHmac } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger, DAY_MS, type Logger } from '@agentmesh/common';
import { afterEach, describe, expect, it } from 'vitest';
import { testTeamConfig } from '../../../testing/fixtures';
import { createServiceHarness } from '../../../testing/services';
import { IngestServiceImpl } from '../ingest.service';
import { authFailureLog, closeServer, startIngestServer } from './server';

const SECRET = 'github-secret-0123456789';
const TOKEN = 'test-token-0123456789abcdef';

let server: Server | null = null;
afterEach(async () => {
  await closeServer(server);
  server = null;
});

async function start() {
  const seen = new Set<string>();
  server = await startIngestServer({
    host: '127.0.0.1',
    port: 0,
    sources: [
      { id: 'hermes', format: 'mesh', auth: { type: 'bearer', token: TOKEN } },
      {
        id: 'github',
        format: 'raw',
        typeHeader: 'x-github-event',
        typeField: 'action',
        idHeader: 'x-github-delivery',
        auth: {
          type: 'hmac-sha256',
          secret: SECRET,
          header: 'x-hub-signature-256',
          prefix: 'sha256=',
        },
      },
    ],
    logger: createLogger('ingest-test', { level: 'silent' }),
    sink: async (_source, event) => {
      const duplicate = seen.has(event.id);
      seen.add(event.id);
      return { duplicate };
    },
    maxBodyBytes: 4096,
  });
  return (server.address() as AddressInfo).port;
}

/**
 * Starts a POST, sends `sent` bytes of the body and stops there (unless `end`). Resolves to the
 * status, or to 'no answer' after a second: what a client gets while the hub still waits.
 */
function partialPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  sent: string,
  end = false,
): Promise<number | 'no answer'> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on('error', () => undefined);
    req.write(sent);
    if (end) req.end();
    setTimeout(() => {
      resolve('no answer');
      req.destroy();
    }, 1000);
  });
}

describe('ingest HTTP hardening', () => {
  it('refuses a wrong bearer token before reading the body', async () => {
    const port = await start();
    const headers = { authorization: 'Bearer wrong', 'content-length': '4000' };
    expect(await partialPost(port, '/v1/ingest/hermes', headers, '{"type":')).toBe(401);
  });

  it('refuses an oversized body without reading it', async () => {
    const port = await start();
    const auth = { authorization: `Bearer ${TOKEN}` };
    const declared = { ...auth, 'content-length': '1000000' };
    expect(await partialPost(port, '/v1/ingest/hermes', declared, 'x')).toBe(413);
    // Chunked, so the size shows only while reading: refused once past the limit.
    const chunked = { ...auth, 'transfer-encoding': 'chunked' };
    expect(await partialPost(port, '/v1/ingest/hermes', chunked, 'x'.repeat(5000))).toBe(413);
  });

  it('bounds slow clients and connections', async () => {
    await start();
    expect(server).toMatchObject({
      headersTimeout: 10_000,
      requestTimeout: 30_000,
      maxConnections: 100,
    });
  });

  it('dedups a signed GitHub delivery replayed under a new delivery id', async () => {
    const port = await start();
    const body = JSON.stringify({ action: 'completed', conclusion: 'failure' });
    const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const post = (delivery: string, event: string) =>
      fetch(`http://127.0.0.1:${port}/v1/ingest/github`, {
        method: 'POST',
        body,
        headers: {
          'x-github-event': event,
          'x-github-delivery': delivery,
          'x-hub-signature-256': signature,
        },
      }).then((r) => r.json() as Promise<{ id: string; duplicate: boolean }>);
    const first = await post('d-1', 'workflow_run');
    expect(first).toEqual({ id: expect.stringMatching(/^github:[0-9a-f]{32}$/), duplicate: false });
    // x-github-delivery and x-github-event are not signed: neither makes the replay new.
    expect(await post('d-2', 'workflow_run')).toEqual({ id: first.id, duplicate: true });
    expect(await post('d-3', 'push')).toEqual({ id: first.id, duplicate: true });
  });
});

describe('ingest auth failure log', () => {
  it('logs once a minute per source, counting the failures in between', () => {
    const lines: unknown[] = [];
    const logger = { warn: (fields: unknown) => lines.push(fields) } as unknown as Logger;
    let now = 0;
    const failed = authFailureLog(logger, () => now);
    for (let i = 0; i < 5; i += 1) failed('hermes');
    failed('github');
    now = 60_000;
    failed('hermes');
    expect(lines).toEqual([
      { source: 'hermes', failures: 1 },
      { source: 'github', failures: 1 },
      { source: 'hermes', failures: 5 },
    ]);
  });
});

describe('ingest retention', () => {
  it('deletes events older than ingest.retentionDays', async () => {
    const h = createServiceHarness(testTeamConfig({ ingest: { retentionDays: 30 } }));
    const ingest = new IngestServiceImpl(h.ctx, {
      messaging: h.messaging,
      presence: h.presence,
      tasks: undefined as never,
    });
    await ingest.accept('hermes', { id: 'old', type: 'cron.daily', severity: 'info', payload: {} });
    h.clock.advance(20 * DAY_MS);
    await ingest.accept('hermes', { id: 'new', type: 'cron.daily', severity: 'info', payload: {} });
    h.clock.advance(11 * DAY_MS);
    ingest.prune(h.clock.now());
    const ids = h.ctx.db.all<{ id: string }>('SELECT id FROM ingest_events').map((r) => r.id);
    expect(ids).toEqual(['hermes:new']);
  });
});
