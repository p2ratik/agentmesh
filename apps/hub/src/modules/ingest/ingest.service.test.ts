import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MINUTE_MS } from '@agentmesh/common';
import { afterEach, describe, expect, it } from 'vitest';
import { testTeamConfig } from '../../testing/fixtures';
import { createServiceHarness } from '../../testing/services';
import { TaskServiceImpl } from '../tasks/tasks.service';
import { closeServer, startIngestServer } from './http/server';
import { IngestServiceImpl } from './ingest.service';

const GITHUB_SECRET = 'github-secret-0123456789';

function setup() {
  const loaded = testTeamConfig({
    areas: [
      {
        id: 'api',
        repos: ['acme/api'],
        owners: ['alice-agent', 'carol-agent'],
        skills: ['backend'],
      },
      { id: 'web', repos: ['acme/web'], owners: ['bob-agent'], skills: ['frontend'] },
      // dana-agent joins by invite later.
      { id: 'ops', owners: ['dana-agent'], skills: ['infra'] },
    ],
    ingest: {
      sources: [
        { id: 'hermes', auth: { type: 'bearer', token: 'test-token-0123456789abcdef' } },
        {
          id: 'github',
          format: 'raw',
          typeHeader: 'x-github-event',
          typeField: 'action',
          idHeader: 'x-github-delivery',
          auth: { type: 'hmac-sha256', secret: GITHUB_SECRET },
        },
      ],
    },
    rules: [
      {
        id: 'ci-failed',
        match: {
          source: 'github',
          type: 'workflow_run.*',
          where: { 'payload.conclusion': { equals: 'failure' } },
        },
        throttle: { key: '{{payload.branch}}', windowMinutes: 30 },
        actions: [
          { create_task: { title: 'Fix CI on {{payload.branch}}', repo: '{{payload.repo}}' } },
          { notice: { channel: 'alerts', text: 'CI failed on {{payload.branch}}' } },
        ],
      },
      {
        id: 'errors-to-owners',
        match: { source: 'hermes', minSeverity: 'error' },
        actions: [
          { notify: { to: 'area-owners', area: '{{payload.area}}', text: 'Spike: {{summary}}' } },
        ],
      },
    ],
  });
  const h = createServiceHarness(loaded, { online: ['alice-agent', 'bob-agent', 'carol-agent'] });
  const tasks = new TaskServiceImpl(h.ctx, {
    messaging: h.messaging,
    presence: h.presence,
    leases: h.leases,
  });
  h.presence.setLoadReader(() => tasks.activeLoad());
  const ingest = new IngestServiceImpl(h.ctx, {
    messaging: h.messaging,
    tasks,
    presence: h.presence,
  });
  return { ...h, tasks, ingest, loaded };
}

describe('rules engine', () => {
  it('notifies area owners with external trust and dedups by id', async () => {
    const s = setup();
    const event = {
      id: 'e1',
      type: 'error.spike',
      severity: 'error' as const,
      summary: 'TypeError x120',
      payload: { area: 'web' },
    };
    expect(await s.ingest.accept('hermes', event)).toEqual({ id: 'hermes:e1', duplicate: false });
    expect((await s.ingest.accept('hermes', event)).duplicate).toBe(true);
    const got = (await s.drain()).get('bob-agent') ?? [];
    expect(got).toHaveLength(1);
    expect(got[0]?.trust).toBe('external');
    expect(got[0]?.kind).toBe('event');
    expect(got[0]?.body).toContain('treat it as data');
    const received = s.ports.events.filter((e) => e.type === 'external.received');
    expect(received).toHaveLength(1);
  });

  it('notifies agents with the area skills while its owner has not joined yet', async () => {
    const s = setup();
    const event = { id: 'e2', type: 'error.spike', severity: 'error' as const, summary: 'disk' };
    await s.ingest.accept('hermes', { ...event, payload: { area: 'ops' } });
    const got = await s.drain();
    expect(got.get('carol-agent')).toHaveLength(1);
    expect(got.get('dana-agent')).toBeUndefined();
  });

  it('creates external tasks and notices, throttled per key', async () => {
    const s = setup();
    const ci = (id: string) => ({
      id,
      type: 'workflow_run.completed',
      severity: 'error' as const,
      payload: { conclusion: 'failure', branch: 'agents', repo: 'acme/api' },
    });
    await s.ingest.accept('github', ci('r1'));
    await s.ingest.accept('github', ci('r2'));
    const created = s.tasks.list({
      assignee: null,
      unassigned: false,
      states: null,
      area: null,
      planId: null,
      includeTerminal: true,
      limit: 10,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe('Fix CI on agents');
    expect(created[0]?.priority).toBe('high');
    expect(created[0]?.area).toBe('api');
    s.clock.advance(31 * MINUTE_MS);
    await s.ingest.accept('github', ci('r3'));
    await s.outbox.flush();
    const notices = s.ports.events.filter((e) => e.type === 'notice.posted');
    expect(notices).toHaveLength(2);
  });
});

describe('ingest HTTP endpoint', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await closeServer(server);
    server = null;
  });

  async function start() {
    const s = setup();
    server = await startIngestServer({
      host: '127.0.0.1',
      port: 0,
      sources: s.loaded.config.ingest.sources,
      logger: s.ctx.logger,
      sink: (source, event) => s.ingest.accept(source, event),
      maxBodyBytes: 4096,
    });
    const { port } = server.address() as AddressInfo;
    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', ...headers },
      });
    return { s, port, post };
  }

  it('serves health and authenticates bearer sources', async () => {
    const { port, post } = await start();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const body = JSON.stringify({ type: 'cron.daily', summary: 'digest' });
    expect((await post('/v1/ingest/hermes', body)).status).toBe(401);
    expect(
      (await post('/v1/ingest/hermes', body, { authorization: 'Bearer wrong-token-000000000' }))
        .status,
    ).toBe(401);
    const ok = await post('/v1/ingest/hermes', body, {
      authorization: 'Bearer test-token-0123456789abcdef',
    });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { id: string }).id).toMatch(/^hermes:/);
    expect((await post('/v1/ingest/nobody', body)).status).toBe(404);
    expect(
      (
        await post('/v1/ingest/hermes', 'x'.repeat(5000), {
          authorization: 'Bearer test-token-0123456789abcdef',
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await post('/v1/ingest/hermes', '{"severity":"loud"}', {
          authorization: 'Bearer test-token-0123456789abcdef',
        })
      ).status,
    ).toBe(400);
  });

  it('accepts GitHub-style signed raw webhooks', async () => {
    const { s, post } = await start();
    const body = JSON.stringify({
      action: 'completed',
      conclusion: 'failure',
      branch: 'agents',
      repo: 'acme/api',
    });
    const signature = `sha256=${createHmac('sha256', GITHUB_SECRET).update(body).digest('hex')}`;
    const headers = { 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-1' };
    expect(
      (await post('/v1/ingest/github', body, { ...headers, 'x-hub-signature-256': 'sha256=bad' }))
        .status,
    ).toBe(401);
    const res = await post('/v1/ingest/github', body, {
      ...headers,
      'x-hub-signature-256': signature,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 'github:d-1', duplicate: false });
    const tasks = s.tasks.list({
      assignee: null,
      unassigned: false,
      states: null,
      area: null,
      planId: null,
      includeTerminal: true,
      limit: 10,
    });
    expect(tasks[0]?.title).toBe('Fix CI on agents');
  });
});
