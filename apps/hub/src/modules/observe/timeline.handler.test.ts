import { randomUUID } from 'node:crypto';
import { createLogger, ManualClock } from '@agentmesh/common';
import { ConfigIndex } from '@agentmesh/config';
import type { ReportedEvent } from '@agentmesh/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../app';
import { MemoryPorts } from '../../ports';
import { testTeamConfig } from '../../testing/fixtures';

const tool = (at = '2026-10-16T08:00:00.000Z'): ReportedEvent => ({
  id: randomUUID(),
  at,
  session: null,
  source: 'plugin',
  kind: 'tool',
  tool: 'ask',
  outcome: 'ok',
  ms: 5,
});

describe('observe.timeline over the router', () => {
  let hub: Hub | null = null;
  let clock = new ManualClock('2026-10-16T09:00:00.000Z');
  afterEach(async () => {
    await hub?.stop();
    hub = null;
  });
  const start = async (observability: object = { viewers: ['alice'] }) => {
    const ports = new MemoryPorts();
    clock = new ManualClock('2026-10-16T09:00:00.000Z');
    hub = await createHub({
      loaded: testTeamConfig({ hub: { http: { enabled: false } }, observability }),
      dataDir: ':memory:',
      nats: null,
      ports: { delivery: ports, events: ports },
      clock,
      logger: createLogger('hub-test', { level: 'silent', destination: 'stderr' }),
    });
    await hub.start();
    return hub;
  };
  const sessions = new WeakMap<Hub, Map<string, string>>();
  const call = async (h: Hub, caller: string, method: string, params: object) => {
    const known = sessions.get(h) ?? new Map<string, string>();
    sessions.set(h, known);
    if (!known.has(caller)) {
      const hello = (await h.dispatch(
        { caller, method: 'session.hello' },
        { clientVersion: '0.7.0' },
      )) as { sessionId: string };
      known.set(caller, hello.sessionId);
    }
    return h.dispatch({ caller, method, session: known.get(caller) }, params);
  };
  // These tests are about reported events; the hub's own (session hellos) are left out.
  const read = (h: Hub, caller: string, params: object = {}) =>
    call(h, caller, 'observe.timeline', { kinds: ['tool'], ...params }) as Promise<{
      events: Array<{ agent: string; id: string }>;
      text: string;
      truncated: boolean;
    }>;
  const report = (h: Hub, caller: string, events: ReportedEvent[]) =>
    call(h, caller, 'telemetry.report', { events });

  it('a non-viewer is refused with forbidden', async () => {
    const h = await start();
    await expect(read(h, 'bob-agent')).rejects.toMatchObject({
      code: 'forbidden',
      message: "the timeline is for this mesh's operators only",
    });
  });

  it('with no viewers configured nobody may read, admins included', async () => {
    const h = await start({});
    await expect(read(h, 'alice-agent')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it("a viewer's agent reads any agent's timeline", async () => {
    const h = await start();
    await report(h, 'bob-agent', [tool()]);
    const out = await read(h, 'alice-agent', { agent: 'bob-agent' });
    expect(out.events.map((e) => e.agent)).toEqual(['bob-agent']);
    expect(out.text).toContain('bob-agent');
    expect(out.text).toContain('ask ok 5ms');
  });

  it("finds the caller's owner through the index, so an agent that joined by invite can read", async () => {
    const h = await start();
    const { config } = h.context.index;
    h.context.setIndex(
      new ConfigIndex({
        ...config,
        agents: [...config.agents, { id: 'alice-laptop-agent', owner: 'alice', skills: [] }],
      }),
    );
    h.services.presence.syncFromConfig();
    await expect(read(h, 'alice-laptop-agent')).resolves.toMatchObject({ truncated: false });
  });

  it('truncated is true past the limit; the newest events are kept, oldest first, and the text says so', async () => {
    const h = await start();
    const events = [tool(), tool(), tool()];
    for (const e of events) {
      await report(h, 'bob-agent', [e]);
      clock.advance(1000);
    }
    const out = await read(h, 'alice-agent', { limit: 2 });
    expect(out.events.map((e) => e.id)).toEqual([events[1]?.id, events[2]?.id]);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('(truncated: showing the newest 2 of more');
    const all = await read(h, 'alice-agent', { limit: 3 });
    expect(all.truncated).toBe(false);
    expect(all.text).not.toContain('truncated');
    expect(all.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it('an empty window says so', async () => {
    const h = await start();
    expect((await read(h, 'alice-agent')).text).toBe('no events in this window');
  });

  it("keeps the session id of events buffered from a session that has since closed, not another agent's", async () => {
    const h = await start();
    const hello = (caller: string) =>
      h.dispatch({ caller, method: 'session.hello' }, { clientVersion: '0.7.0' }) as Promise<{
        sessionId: string;
      }>;
    const old = await hello('bob-agent');
    await h.dispatch({ caller: 'bob-agent', method: 'session.bye', session: old.sessionId }, {});
    const buffered = { ...tool(), session: old.sessionId } as ReportedEvent;
    await report(h, 'bob-agent', [buffered]);
    await report(h, 'carol-agent', [{ ...tool(), session: old.sessionId } as ReportedEvent]);
    const bySession = async (agent: string) =>
      (await read(h, 'alice-agent', { agent })).events.map(
        (e) => (e as { session?: string }).session,
      );
    expect(await bySession('bob-agent')).toEqual([old.sessionId]);
    expect(await bySession('carol-agent')).toEqual([null]);
  });

  it('since and until take an ISO time or a duration; anything else is invalid_request', async () => {
    const h = await start();
    await report(h, 'bob-agent', [tool()]);
    expect((await read(h, 'alice-agent', { since: '30m' })).events).toHaveLength(1);
    expect((await read(h, 'alice-agent', { since: '2026-10-16T09:30:00Z' })).events).toHaveLength(
      0,
    );
    expect((await read(h, 'alice-agent', { until: '10m' })).events).toHaveLength(0);
    const bad: Array<[string, string]> = [
      ['since', 'yesterday'],
      ['until', '5x'],
      ['since', '2026-13-45T00:00:00Z'],
    ];
    for (const [key, value] of bad) {
      await expect(read(h, 'alice-agent', { [key]: value })).rejects.toMatchObject({
        code: 'invalid_request',
        message: `${key} must be an ISO time or a duration like 30m, 2h, 1d`,
      });
    }
  });
});
