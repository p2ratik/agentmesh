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
  afterEach(async () => {
    await hub?.stop();
    hub = null;
  });
  const start = async (observability: object = { viewers: ['alice'] }) => {
    const ports = new MemoryPorts();
    hub = await createHub({
      loaded: testTeamConfig({ hub: { http: { enabled: false } }, observability }),
      dataDir: ':memory:',
      nats: null,
      ports: { delivery: ports, events: ports },
      clock: new ManualClock('2026-10-16T09:00:00.000Z'),
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
  const read = (h: Hub, caller: string, params: object = {}) =>
    call(h, caller, 'observe.timeline', params) as Promise<{
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

  it('truncated is true past the limit, and the newest events are kept', async () => {
    const h = await start();
    await report(h, 'bob-agent', [tool(), tool(), tool()]);
    const out = await read(h, 'alice-agent', { limit: 2 });
    expect(out.events).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect((await read(h, 'alice-agent', { limit: 3 })).truncated).toBe(false);
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
