import { randomUUID } from 'node:crypto';
import { createLogger, ManualClock } from '@agentmesh/common';
import type { HubEvent, ReportedEvent } from '@agentmesh/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub, type Hub } from '../../app';
import { MemoryPorts } from '../../ports';
import { testTeamConfig } from '../../testing/fixtures';
import { createTestHarness } from '../../testing/harness';
import { ObserveService } from './observe.service';

const obs = (o: object = {}) => ({ observability: { ...o } });
const tool = (id = randomUUID(), at = '2026-10-16T09:00:00.000Z'): ReportedEvent => ({
  id,
  at,
  session: null,
  source: 'plugin',
  kind: 'tool',
  tool: 'ask',
  outcome: 'ok',
  ms: 5,
});
const hubEvent = (): HubEvent => ({
  id: randomUUID(),
  at: '2026-10-16T09:00:00.000Z',
  session: null,
  source: 'hub',
  kind: 'orphan',
  thread: 'thr-1',
  phase: 'recorded',
});
const rows = (ctx: ReturnType<typeof createTestHarness>['ctx']) =>
  ctx.db.all<{ agent: string; body: string }>('SELECT agent, body FROM events');

describe('ObserveService', () => {
  it("stores reported events under the caller, and the caller's id wins over a reported agent field", () => {
    const { ctx } = createTestHarness();
    const service = new ObserveService(ctx, () => true);
    const forged = { ...tool(), agent: 'mallory-agent' } as unknown as ReportedEvent;
    expect(service.report('alice-agent', [forged])).toEqual({ accepted: 1, dropped: 0 });
    expect(rows(ctx).map((r) => r.agent)).toEqual(['alice-agent']);
    const [event] = service.query({});
    expect(event?.agent).toBe('alice-agent');
  });

  it('a resent batch is stored once', () => {
    const { ctx } = createTestHarness();
    const service = new ObserveService(ctx, () => true);
    const batch = [tool(), tool()];
    service.report('alice-agent', batch);
    expect(service.report('alice-agent', batch)).toEqual({ accepted: 2, dropped: 0 });
    expect(rows(ctx)).toHaveLength(2);
  });

  it('caps events per agent per minute', () => {
    const { ctx, clock } = createTestHarness(testTeamConfig(obs({ maxEventsPerMinute: 5 })));
    const service = new ObserveService(ctx, () => true);
    const eight = Array.from({ length: 8 }, () => tool());
    expect(service.report('alice-agent', eight)).toEqual({ accepted: 5, dropped: 3 });
    // Another agent has its own budget; the same agent has room again a minute later.
    expect(service.report('bob-agent', [tool()]).accepted).toBe(1);
    clock.advance(61_000);
    expect(service.report('alice-agent', [tool()]).accepted).toBe(1);
  });

  it('refuses telemetry when observability is off', () => {
    const { ctx } = createTestHarness(testTeamConfig(obs({ enabled: false })));
    expect(() => new ObserveService(ctx, () => true).report('alice-agent', [tool()])).toThrow(
      'observability is turned off on this hub',
    );
  });

  it('ctx.events records a hub event, and records nothing when off', () => {
    const on = createTestHarness();
    on.ctx.events.record('alice-agent', hubEvent());
    expect(rows(on.ctx).map((r) => r.agent)).toEqual(['alice-agent']);
    const off = createTestHarness(testTeamConfig(obs({ enabled: false })));
    off.ctx.events.record('alice-agent', hubEvent());
    expect(rows(off.ctx)).toEqual([]);
  });

  it('ctx.events caps rpc events per caller a minute, and auth events under one shared budget', () => {
    const { ctx, clock } = createTestHarness(testTeamConfig(obs({ maxEventsPerMinute: 2 })));
    const base = { id: '', at: '2026-10-16T09:00:00.000Z', session: null, source: 'hub' } as const;
    const rpc = (caller: string): HubEvent => {
      const fields = { kind: 'rpc', method: 'mesh.status', caller, code: 'forbidden' } as const;
      return { ...base, id: randomUUID(), ...fields };
    };
    const denied = (): HubEvent => {
      const fields = { kind: 'auth', event: 'denied', reason: 'auth.no_signature' } as const;
      return { ...base, id: randomUUID(), ...fields };
    };
    const count = (key: string) =>
      rows(ctx).filter((r) => `${r.agent} ${JSON.parse(r.body).kind}` === key).length;
    const warn = vi.fn();
    ctx.logger = { warn, debug: vi.fn() } as never;
    for (let i = 0; i < 3; i++) {
      ctx.events.record('alice-agent', rpc('alice-agent'));
      ctx.events.record('bob-agent', rpc('bob-agent'));
      ctx.events.record('hub', denied());
      ctx.events.record('alice-agent', hubEvent()); // the hub's own state changes: not capped
    }
    const keys = ['alice-agent rpc', 'bob-agent rpc', 'hub auth', 'alice-agent orphan'];
    expect(keys.map(count)).toEqual([2, 2, 2, 3]);
    // One warning per budget the first time it fills; later drops log at debug.
    const warned = warn.mock.calls.map(([fields]) => fields.budget);
    expect(warned).toEqual(['alice-agent', 'bob-agent', '(unauthenticated)']);
    clock.advance(61_000);
    ctx.events.record('alice-agent', rpc('alice-agent'));
    expect(count('alice-agent rpc')).toBe(3);
  });

  it('ctx.events never throws', () => {
    const { ctx } = createTestHarness();
    ctx.db.exec('DROP TABLE events');
    expect(() => ctx.events.record('alice-agent', hubEvent())).not.toThrow();
  });

  it('prunes events older than retentionDays', () => {
    const { ctx, clock } = createTestHarness(testTeamConfig(obs({ retentionDays: 2 })));
    const service = new ObserveService(ctx, () => true);
    service.report('alice-agent', [tool()]);
    clock.advance(1 * 86_400_000);
    service.report('alice-agent', [tool()]);
    clock.advance(1.5 * 86_400_000);
    expect(service.prune(clock.now())).toBe(1);
    expect(rows(ctx)).toHaveLength(1);
  });
});

describe('telemetry.report over the router', () => {
  let hub: Hub | null = null;
  afterEach(async () => {
    await hub?.stop();
    hub = null;
  });
  const start = async () => {
    const ports = new MemoryPorts();
    hub = await createHub({
      loaded: testTeamConfig({ hub: { http: { enabled: false } } }),
      dataDir: ':memory:',
      nats: null,
      ports: { delivery: ports, events: ports },
      clock: new ManualClock('2026-10-16T09:00:00.000Z'),
      logger: createLogger('hub-test', { level: 'silent', destination: 'stderr' }),
    });
    await hub.start();
    return hub;
  };

  it('stores an agent report under the caller and refuses humans and services', async () => {
    const h = await start();
    const hello = (await h.dispatch(
      { caller: 'alice-agent', method: 'session.hello' },
      { clientVersion: '0.6.0' },
    )) as { sessionId: string; observability: unknown };
    expect(hello.observability).toEqual({ enabled: true, maxBufferedEvents: 500 });
    const ctx = { caller: 'alice-agent', method: 'telemetry.report', session: hello.sessionId };
    expect(await h.dispatch(ctx, { events: [tool()] })).toEqual({ accepted: 1, dropped: 0 });
    await expect(
      h.dispatch(
        { caller: 'discord-bridge', method: 'telemetry.report', actAs: 'alice' },
        { events: [] },
      ),
    ).rejects.toThrow(/may not call telemetry.report/);
    await expect(
      h.dispatch({ caller: 'discord-bridge', method: 'telemetry.report' }, { events: [] }),
    ).rejects.toThrow(/may not call telemetry.report/);
  });

  it('session.hello reports the observability config', async () => {
    const h = await start();
    h.context.loaded = testTeamConfig(obs({ enabled: false, client: { maxBufferedEvents: 70 } }));
    const hello = (await h.dispatch(
      { caller: 'bob-agent', method: 'session.hello' },
      { clientVersion: '0.6.0' },
    )) as { observability: unknown };
    expect(hello.observability).toEqual({ enabled: false, maxBufferedEvents: 70 });
  });
});
