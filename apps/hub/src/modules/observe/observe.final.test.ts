import { randomUUID } from 'node:crypto';
import { type HubEvent, RPC_METHODS } from '@agentmesh/protocol';
import { describe, expect, it, vi } from 'vitest';
import { testTeamConfig } from '../../testing/fixtures';
import { createTestHarness } from '../../testing/harness';
import { createBobDispatchHarness } from '../../testing/services';
import { ObserveService } from './observe.service';

type Ctx = ReturnType<typeof createTestHarness>['ctx'];
const AT = '2026-10-16T09:00:00.000Z';
const tool = (over: object = {}) => ({
  id: randomUUID(),
  at: AT,
  session: null,
  source: 'plugin',
  kind: 'tool',
  tool: 'ask',
  outcome: 'ok',
  ms: 5,
  ...over,
});
const orphan = (): HubEvent => ({
  id: randomUUID(),
  at: AT,
  session: null,
  source: 'hub',
  kind: 'orphan',
  thread: 'thr-1',
  phase: 'recorded',
});
const takenOver = (threads: string[]) =>
  ({
    id: randomUUID(),
    at: AT,
    session: null,
    source: 'hub',
    kind: 'session',
    phase: 'taken_over',
    threads,
  }) as HubEvent;
/** What is stored, once the hub's queued events are written. */
const bodies = (ctx: Ctx): Array<Record<string, unknown>> => {
  ctx.events.flush();
  return ctx.db
    .all<{ body: string }>('SELECT body FROM events ORDER BY rowid')
    .map((r) => JSON.parse(r.body));
};
const many = (n: number) => Array.from({ length: n }, () => tool());

describe('a hub event that fails its schema is never stored (I1)', () => {
  it('a takeover of 51 threads keeps the first 50 and the count, and its timeline parses', () => {
    const h = createBobDispatchHarness();
    const old = h.meshWindow();
    for (let i = 0; i < 51; i++) h.sessions.take('bob-agent', old, h.thread());
    h.sessions.unreachable(old);
    h.meshWindow();
    const e = bodies(h.ctx).find((x) => x.phase === 'taken_over');
    expect(e?.threads).toHaveLength(50);
    expect(e?.threadCount).toBe(51);
    h.ctx.loaded = testTeamConfig({ observability: { viewers: ['alice'] } });
    const reply = new ObserveService(h.ctx, () => true).timeline('alice-agent', {
      agent: 'bob-agent',
      since: '2h',
      limit: 500,
    });
    expect(reply.text).toContain('taken_over');
    expect(RPC_METHODS['observe.timeline'].result.safeParse(reply).success).toBe(true);
  });

  it('the sink drops an event or agent that fails the schema, with a debug log', () => {
    const { ctx } = createTestHarness();
    const debug = vi.fn();
    ctx.logger = { debug, warn: vi.fn() } as never;
    ctx.events.record('bob-agent', takenOver(Array.from({ length: 51 }, (_, i) => `thr-${i}`)));
    ctx.events.record('Not An Id', orphan());
    ctx.events.record('bob-agent', takenOver(['thr-1']));
    expect(bodies(ctx).map((b) => b.threads)).toEqual([['thr-1']]);
    const why = debug.mock.calls.map(([fields, text]) => [fields.kind, text]);
    expect(why).toEqual([
      ['session', 'hub event fails its schema; not recorded'],
      ['orphan', 'hub event fails its schema; not recorded'],
    ]);
  });
});

describe('batched writes (I3)', () => {
  it('a 100-event report is one transaction', () => {
    const { ctx } = createTestHarness();
    const service = new ObserveService(ctx, () => true);
    const tx = vi.spyOn(ctx.db, 'transaction');
    expect(service.report('alice-agent', many(100))).toEqual({ accepted: 100, dropped: 0 });
    expect(tx).toHaveBeenCalledOnce();
    expect(bodies(ctx)).toHaveLength(100);
  });

  it("the hub's own events of one task are written together once it yields", async () => {
    const { ctx } = createTestHarness();
    const tx = vi.spyOn(ctx.db, 'transaction');
    for (let i = 0; i < 100; i++) ctx.events.record('alice-agent', orphan());
    expect(tx).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(tx).toHaveBeenCalledOnce();
    expect(bodies(ctx)).toHaveLength(100);
  });

  it('a failed write never throws, and loses only its own batch', async () => {
    const { ctx } = createTestHarness();
    ctx.logger = { debug: vi.fn(), warn: vi.fn() } as never;
    ctx.db.exec('ALTER TABLE events RENAME TO events_gone');
    ctx.events.record('alice-agent', orphan());
    expect(() => ctx.events.flush()).not.toThrow();
    ctx.db.exec('ALTER TABLE events_gone RENAME TO events');
    ctx.events.record('alice-agent', orphan());
    await Promise.resolve();
    expect(bodies(ctx)).toHaveLength(1);
  });
});

describe('each reported event is validated on its own (I4)', () => {
  it('one unknown kind costs only that event', () => {
    const { ctx } = createTestHarness();
    const service = new ObserveService(ctx, () => true);
    const batch = [...many(99), { ...tool(), kind: 'a_later_kind' }];
    expect(service.report('alice-agent', batch)).toEqual({ accepted: 99, dropped: 1 });
    expect(bodies(ctx)).toHaveLength(99);
  });

  it('the budget counts only valid events', () => {
    const { ctx } = createTestHarness(testTeamConfig({ observability: { maxEventsPerMinute: 3 } }));
    const service = new ObserveService(ctx, () => true);
    const bad = { ...tool(), reason: 'a.later_code' };
    expect(service.report('alice-agent', [bad, bad, ...many(4)])).toEqual({
      accepted: 3,
      dropped: 3,
    });
    expect(bodies(ctx).map((b) => b.reason)).toEqual([undefined, undefined, undefined]);
    expect(service.report('alice-agent', many(1))).toEqual({ accepted: 0, dropped: 1 });
  });

  it('the contract takes up to 100 values of any shape', () => {
    const { params } = RPC_METHODS['telemetry.report'];
    expect(params.safeParse({ events: [{ kind: 'a_later_kind' }, 7] }).success).toBe(true);
    expect(params.safeParse({ events: many(101) }).success).toBe(false);
  });
});
