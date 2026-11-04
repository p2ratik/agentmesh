import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@agentmesh/common';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthReport } from '../../../runtime/health';
import { closeServer, startIngestServer } from './server';

let server: Server | null = null;
afterEach(async () => {
  await closeServer(server);
  server = null;
});

async function healthz(health?: () => Promise<HealthReport>) {
  server = await startIngestServer({
    host: '127.0.0.1',
    port: 0,
    sources: [],
    logger: createLogger('healthz-test', { level: 'silent' }),
    sink: async () => ({ duplicate: false }),
    health,
  });
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  return { status: res.status, body: await res.json() };
}

const checks = { started: true, db: true, nats: true, subscriptions: true };

describe('GET /healthz', () => {
  it('says only that the server is up when no readiness is given', async () => {
    expect(await healthz()).toEqual({ status: 200, body: { ok: true } });
  });

  it('is 200 with the checks when the hub is ready', async () => {
    const report = { ok: true, checks };
    expect(await healthz(async () => report)).toEqual({ status: 200, body: report });
  });

  // Docker's healthcheck and the deploy gate both read the status code.
  it('is 503 and names the failing check when the hub is not ready', async () => {
    const report = { ok: false, checks: { ...checks, nats: false } };
    expect(await healthz(async () => report)).toEqual({ status: 503, body: report });
  });
});
