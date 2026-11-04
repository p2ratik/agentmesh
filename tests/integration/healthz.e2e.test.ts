import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@agentmesh/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';

/**
 * `/healthz` is the deploy gate (docs/deploy.md#automatic-deploys): it must turn 503 when the
 * hub loses NATS, and 200 again once NATS is back. Runs its own nats-server, which it kills.
 * Needs AGENTMESH_TEST_NATS_BIN=<path to nats-server>.
 */
const NATS_BIN = process.env.AGENTMESH_TEST_NATS_BIN ?? '';
const NATS_PORT = 4900 + Math.floor(Date.now() % 90);
const HTTP_PORT = 18_000 + Math.floor(Date.now() % 900);

type Report = { ok?: boolean; checks?: Record<string, boolean> };

async function healthz(): Promise<{ status: number; body: Report }> {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`);
  return { status: res.status, body: (await res.json()) as Report };
}

async function until(status: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await healthz();
    if (answer.status === status || Date.now() > deadline) return answer;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!NATS_BIN || !existsSync(NATS_BIN))('hub readiness at /healthz', () => {
  const store = mkdtempSync(join(tmpdir(), 'agentmesh-healthz-'));
  const startNats = () =>
    spawn(NATS_BIN, ['-js', '-p', String(NATS_PORT), '-a', '127.0.0.1', '-sd', store], {
      stdio: 'ignore',
    });
  let server: ChildProcess;
  let hub: Hub;

  beforeAll(async () => {
    server = startNats();
    hub = await createHub({
      loaded: testTeamConfig({
        mesh: { name: 'healthz-e2e', prefix: 'healthze2e' },
        hub: { http: { enabled: true, host: '127.0.0.1', port: HTTP_PORT }, tickSeconds: 1 },
      }),
      dataDir: ':memory:',
      nats: { servers: [`nats://127.0.0.1:${NATS_PORT}`] },
      logger: createLogger('healthz-hub', { level: 'silent' }),
    });
    await hub.start();
  }, 30_000);

  afterAll(async () => {
    await hub?.stop();
    server?.kill();
  });

  it('is ready once started, 503 without NATS, and ready again when NATS returns', async () => {
    expect(await healthz()).toEqual({
      status: 200,
      body: { ok: true, checks: { started: true, db: true, nats: true, subscriptions: true } },
    });

    server.kill();
    const down = await until(503);
    expect(down.status).toBe(503);
    expect(down.body.checks).toEqual({ started: true, db: true, nats: false, subscriptions: true });

    server = startNats();
    expect((await until(200)).status).toBe(200);
  }, 60_000);
});
