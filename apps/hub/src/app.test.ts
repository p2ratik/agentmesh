import { createLogger, ManualClock } from '@agentmesh/common';
import type { MeshMessage } from '@agentmesh/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from './app';
import { MemoryPorts } from './ports';
import { testTeamConfig } from './testing/fixtures';

let hub: Hub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

async function start(overrides: Record<string, unknown> = {}) {
  const ports = new MemoryPorts();
  const clock = new ManualClock('2026-10-16T09:00:00.000Z');
  hub = await createHub({
    loaded: testTeamConfig({ hub: { http: { enabled: false } }, ...overrides }),
    dataDir: ':memory:',
    nats: null,
    ports: { delivery: ports, events: ports },
    clock,
    logger: createLogger('hub-test', { level: 'silent', destination: 'stderr' }),
  });
  await hub.start();
  const h = hub;
  const sessionIds = new Map<string, string>();
  /** Agents call as a session, like the plugin: their first call says hello. */
  const call = async <T = Record<string, unknown>>(
    caller: string,
    method: string,
    params: unknown = {},
    actAs?: string,
  ): Promise<T> => {
    const agent = h.context.index.kindOf(caller) === 'agent' && method !== 'session.hello';
    if (agent && !sessionIds.has(caller)) {
      await call(caller, 'session.hello', { clientVersion: '0.3.0' });
    }
    const session = agent ? sessionIds.get(caller) : undefined;
    const ctx = { caller, method, ...(actAs ? { actAs } : {}), ...(session ? { session } : {}) };
    const result = (await h.dispatch(ctx, params)) as T & { sessionId?: string };
    if (method === 'session.hello' && result.sessionId) sessionIds.set(caller, result.sessionId);
    return result;
  };
  const inbox = async (id: string): Promise<MeshMessage[]> => {
    await h.tick();
    return ports.deliveredTo(id);
  };
  return { hub: h, ports, clock, call, inbox };
}

describe('hub end to end (no NATS)', () => {
  it('createHub without NATS still delivers through the injected ports', async () => {
    const { call, inbox, ports } = await start();
    // bob has no session: the session dispatcher would hold this, the injected port takes it.
    await call('alice-agent', 'message.send', { kind: 'ask', to: ['bob-agent'], body: 'wired?' });
    expect((await inbox('bob-agent')).map((m) => m.body)).toEqual(['wired?']);
    expect(ports.events.map((e) => e.type)).toContain('message.created');
  });

  it('connects an agent, then routes an ask and a threaded reply', async () => {
    const { call, inbox } = await start();
    const hello = await call<{
      self: { status: string };
      policy: { git: { integrationBranch: string } };
    }>('alice-agent', 'session.hello', {
      clientVersion: '0.3.0',
      repo: 'acme/api',
      branch: 'main',
    });
    expect(hello.self.status).toBe('online');
    expect(hello.policy.git.integrationBranch).toBe('agents');

    const sent = await call<{ threadId: string }>('alice-agent', 'message.send', {
      kind: 'ask',
      to: ['bob-agent'],
      body: 'Is the render API ready for status codes?',
    });
    const asked = await inbox('bob-agent');
    expect(asked[0]?.body).toContain('render API');
    expect(asked[0]?.from.id).toBe('alice-agent');

    await call('bob-agent', 'message.send', {
      kind: 'reply',
      threadId: sent.threadId,
      body: 'Yes — use an enum.',
      status: 'answer',
    });
    const answered = await inbox('alice-agent');
    expect(answered.at(-1)?.status).toBe('answer');

    // Replying no longer marks the ask read: only a session ack or reading it does.
    const unread = await call<{ threads: unknown[] }>('bob-agent', 'inbox.get');
    expect(unread.threads).toHaveLength(1);
    const reread = await call<{ threads: unknown[] }>('bob-agent', 'inbox.get');
    expect(reread.threads).toHaveLength(0);
    const aliceInbox = await call<{ threads: Array<{ unread: number }> }>(
      'alice-agent',
      'inbox.get',
    );
    expect(aliceInbox.threads[0]?.unread).toBe(1);
  });

  it('stops agent-to-agent loops at the configured depth', async () => {
    const { call } = await start({ limits: { maxThreadDepth: 1 } });
    const first = await call<{ threadId: string }>('alice-agent', 'message.send', {
      kind: 'ask',
      to: ['bob-agent'],
      body: 'a',
    });
    const second = await call<{ threadId: string }>('bob-agent', 'message.send', {
      kind: 'ask',
      to: ['carol-agent'],
      body: 'b',
      parentThreadId: first.threadId,
    });
    await expect(
      call('carol-agent', 'message.send', {
        kind: 'ask',
        to: ['alice-agent'],
        body: 'c',
        parentThreadId: second.threadId,
      }),
    ).rejects.toThrow(/deeper than 1/);
  });

  it('holds deliveries while paused and releases them on resume (admins only)', async () => {
    const { call, inbox, ports } = await start();
    await expect(call('discord-bridge', 'mesh.pause', {}, 'bob')).rejects.toThrow(/admin/);
    await call('discord-bridge', 'mesh.pause', { reason: 'incident' }, 'alice');
    const status = await call<{ paused: boolean }>('alice-agent', 'mesh.status');
    expect(status.paused).toBe(true);
    await call('alice-agent', 'message.send', { kind: 'ask', to: ['bob-agent'], body: 'queued?' });
    expect(await inbox('bob-agent')).toHaveLength(0);
    const resumed = await call<{ released: number }>('discord-bridge', 'mesh.resume', {}, 'alice');
    expect(resumed.released).toBe(1);
    expect(await inbox('bob-agent')).toHaveLength(1);
    expect(ports.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['mesh.paused', 'mesh.resumed']),
    );
  });

  it('lets the bridge act for humans but not agents impersonate anyone', async () => {
    const { call } = await start();
    const asked = await call<{ deliveredTo: string[] }>(
      'discord-bridge',
      'message.send',
      { kind: 'ask', to: ['carol-agent'], body: 'From Discord' },
      'bob',
    );
    expect(asked.deliveredTo).toEqual(['carol-agent']);
    await expect(
      call('alice-agent', 'message.send', { kind: 'ask', to: ['bob-agent'], body: 'x' }, 'bob'),
    ).rejects.toThrow(/may not act on behalf/);
    await expect(call('mallory', 'peers.list')).rejects.toThrow(/Unknown participant/);
    await expect(
      call('discord-bridge', 'refs.set', {
        system: 'discord',
        entityType: 'thread',
        entityId: 'thr-1',
        ref: '123',
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('runs a /plan session into routed tasks', async () => {
    const { call, clock, hub: h } = await start();
    for (const id of ['alice-agent', 'bob-agent', 'carol-agent'])
      await call(id, 'session.hello', { clientVersion: '0.3.0' });
    const plan = await call<{ id: string; facilitator: string }>(
      'discord-bridge',
      'plan.start',
      { topic: 'Ship render status' },
      'carol',
    );
    expect(plan.facilitator).toBe('carol-agent');
    clock.advance(60 * 60_000);
    await h.tick();
    await h.tick();
    const submitted = await call<{ state: string; taskIds: string[] }>(
      'carol-agent',
      'plan.submit',
      {
        planId: plan.id,
        summary: 'Enum status; web shows it.',
        tasks: [
          { key: 'api', title: 'Status enum in API', description: '', area: 'api' },
          {
            key: 'web',
            title: 'Render status badge',
            description: '',
            area: 'web',
            dependsOn: ['api'],
          },
        ],
      },
    );
    expect(submitted.state).toBe('materialized');
    const web = await call<{ assignee: string | null; dependsOn: string[] }>(
      'bob-agent',
      'task.get',
      { taskId: submitted.taskIds[1] },
    );
    expect(web.dependsOn).toEqual([submitted.taskIds[0]]);
    const status = await call<{ counts: { openTasks: number; activePlans: number } }>(
      'alice-agent',
      'mesh.status',
    );
    expect(status.counts).toMatchObject({ openTasks: 2, activePlans: 0 });
  });
});
