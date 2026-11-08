import { createLogger, ManualClock, MeshError } from '@agentmesh/common';
import { HubEvent } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { createHub } from '../../app';
import { MemoryPorts } from '../../ports';
import { IdempotencyStore } from '../../rpc/idempotency';
import { createRpcRouter } from '../../rpc/router';
import { buildModules } from '../../runtime/modules';
import { testTeamConfig } from '../../testing/fixtures';
import { createTestHarness } from '../../testing/harness';
import { createBobDispatchHarness } from '../../testing/services';
import { readInbox } from '../messaging/inbox';
import type { MessagingServiceImpl } from '../messaging/messaging.service';
import { hubRecorder } from './hub-event';

type Row = Record<string, unknown>;
type HasDb = { ctx: { db: { all<T>(sql: string): T[] }; events: { flush(): void } } };
/** The stored hub events, once the queued ones are written. */
const recorded = (h: HasDb, kind?: string): Row[] => {
  h.ctx.events.flush();
  return h.ctx.db
    .all<{ body: string }>('SELECT body FROM events ORDER BY rowid')
    .map((r) => HubEvent.parse(JSON.parse(r.body)) as unknown as Row)
    .filter((e) => !kind || e.kind === kind);
};
const phases = (h: Parameters<typeof recorded>[0], kind = 'session') =>
  recorded(h, kind).map((e) => e.phase);

describe('the hub records its own events', () => {
  it('a session that goes away and closes records away then closed', () => {
    const h = createBobDispatchHarness();
    const s = h.active();
    h.clock.advance(76_000);
    h.sessions.expire(h.clock.now());
    h.clock.advance(121 * 60_000);
    h.sessions.expire(h.clock.now());
    const events = recorded(h, 'session').filter((e) => e.session === s);
    expect(events.map((e) => e.phase)).toEqual(['opened', 'away', 'closed']);
  });

  it('a heartbeat after away records live', () => {
    const h = createBobDispatchHarness();
    const s = h.active();
    h.sessions.unreachable(s);
    h.sessions.touch('bob-agent', s);
    expect(phases(h)).toEqual(['opened', 'away', 'live']);
  });

  it('a delivery records sent and acked with the message and thread', async () => {
    const h = createBobDispatchHarness();
    const s = h.active();
    const m = h.ask(h.thread());
    await h.outbox.flush();
    const d = recorded(h, 'delivery');
    expect(d.map((e) => [e.stage, e.message, e.thread, e.session])).toEqual([
      ['sent', m.id, m.threadId, s],
      ['acked', m.id, m.threadId, s],
    ]);
  });

  it('a failed send records failed with a code', async () => {
    const h = createBobDispatchHarness();
    const s = h.active();
    h.transport.respond.set(s, () => Promise.reject(new Error('nobody home')));
    h.ask(h.thread());
    await h.outbox.flush();
    expect(recorded(h, 'delivery').map((e) => [e.stage, e.code])).toEqual([
      ['sent', undefined],
      ['failed', 'unreachable'],
    ]);
  });

  it('a message nobody can take records no_session once', async () => {
    const h = createBobDispatchHarness();
    h.sessions.open('bob-agent', { clientVersion: '0.2.0' });
    h.ask(h.thread());
    await h.outbox.flush();
    await h.outbox.flush();
    expect(recorded(h, 'delivery').map((e) => e.stage)).toEqual(['no_session']);
  });

  it('a relay pointer records sent and forwarded', async () => {
    const h = createBobDispatchHarness();
    const w = h.meshWindow();
    const p = h.sessions.open('bob-agent', { clientVersion: '0.6.0' }).session.id;
    const t = h.thread();
    h.sessions.take('bob-agent', p, t);
    const m = h.reply(t);
    await h.outbox.flush();
    expect(recorded(h, 'relay').map((e) => [e.stage, e.message, e.session])).toEqual([
      ['sent', m.id, w],
      ['forwarded', m.id, w],
    ]);
  });

  it('a takeover records taken_over with the threads', () => {
    const h = createBobDispatchHarness();
    const old = h.meshWindow();
    const t = h.thread();
    h.sessions.take('bob-agent', old, t);
    h.sessions.unreachable(old);
    const w = h.meshWindow();
    const e = recorded(h, 'session').find((x) => x.phase === 'taken_over');
    expect(e).toMatchObject({ session: w, replacedSession: old, threads: [`thr-${t}`] });
  });

  it('an orphan escalation records recorded then escalated; once owned it records settled', async () => {
    const h = createBobDispatchHarness();
    h.meshWindow();
    const p = h.sessions.open('bob-agent', { clientVersion: '0.6.0' }).session.id;
    const t = h.thread();
    h.sessions.take('bob-agent', p, t);
    h.sessions.close('bob-agent', p);
    h.reply(t);
    await h.outbox.flush();
    h.clock.advance(15 * 60_000);
    h.orphans.tick(h.clock.now());
    expect(phases(h, 'orphan')).toEqual(['recorded', 'escalated']);
    h.sessions.take('bob-agent', h.meshWindow(), t);
    h.clock.advance(60_000);
    h.orphans.tick(h.clock.now());
    expect(phases(h, 'orphan')).toEqual(['recorded', 'escalated', 'settled']);
  });

  it('forget records settled only for threads that had a decision row', () => {
    const h = createBobDispatchHarness();
    h.orphans.forget('bob-agent', [h.thread()]);
    expect(phases(h, 'orphan')).toEqual([]);
    h.ctx.db.run(
      "INSERT INTO orphan_decisions (thread_id, agent_id, released_by, due_at) VALUES (1, 'bob-agent', 's', 'x')",
    );
    h.orphans.forget('bob-agent', [1]);
    expect(phases(h, 'orphan')).toEqual(['settled']);
  });

  it('an RPC error records the method and code but no params', async () => {
    const h = createBobDispatchHarness();
    const dispatch = createRpcRouter({
      index: () => h.ctx.index,
      handlers: {
        'mesh.status': async () => {
          throw new MeshError('not_found', 'secret-text-in-error');
        },
      } as never,
      idempotency: new IdempotencyStore(h.ctx.db, h.clock),
      logger: h.ctx.logger,
      transaction: (fn) => h.ctx.db.transaction(fn),
      onError: (caller, method, code) =>
        hubRecorder(h.ctx)(caller, null, { kind: 'rpc', method, caller, code }),
    });
    await expect(
      dispatch({ caller: 'alice-agent', method: 'mesh.status' }, { token: 'p4rams' }),
    ).rejects.toThrow();
    const [e] = recorded(h, 'rpc');
    expect(e).toMatchObject({ method: 'mesh.status', caller: 'alice-agent', code: 'not_found' });
    h.ctx.events.flush();
    const raw = JSON.stringify(h.ctx.db.all('SELECT * FROM events'));
    expect(raw).not.toMatch(/p4rams|secret-text/);
  });
  it('unreachable records away', () => {
    const h = createBobDispatchHarness();
    h.sessions.unreachable(h.active());
    expect(phases(h)).toEqual(['opened', 'away']);
  });

  it('unreachable records away once, and not for an away or closed session', () => {
    const h = createBobDispatchHarness();
    const s = h.active();
    h.sessions.unreachable(s);
    h.sessions.unreachable(s);
    expect(phases(h)).toEqual(['opened', 'away']);
    h.sessions.close('bob-agent', s);
    h.sessions.unreachable(s);
    expect(phases(h)).toEqual(['opened', 'away', 'closed']);
  });

  it('forgets the oldest no_session memory past the cap', async () => {
    const h = createBobDispatchHarness();
    h.sessions.open('bob-agent', { clientVersion: '0.2.0' });
    const m = h.ask(h.thread());
    const copies = Array.from({ length: 1001 }, (_, i) => ({
      ...m,
      id: `msg-${String(i).padStart(26, '0')}`,
    }));
    await h.dispatcher.deliver('bob-agent', copies);
    expect(h.dispatcher.notedCount).toBe(1000);
    expect(recorded(h, 'delivery')).toHaveLength(1001);
  });

  it('hello vs opened, and a full agent evicts', () => {
    const h = createTestHarness(testTeamConfig({ limits: { maxSessionsPerAgent: 1 } }));
    const { sessions } = buildModules(h.ctx, null, { kick: null }).services;
    const a = sessions.open('alice-agent', { clientVersion: '0.7.0' }).session.id;
    sessions.open('alice-agent', { clientVersion: '0.7.0', previousSessionId: a });
    const b = sessions.open('alice-agent', { clientVersion: '0.7.0' }).session.id;
    expect(recorded(h, 'session').map((e) => [e.phase, e.session])).toEqual([
      ['opened', a],
      ['hello', a],
      ['evicted', a],
      ['opened', b],
    ]);
  });

  it('a relay the window did not forward records not_forwarded', async () => {
    const h = createBobDispatchHarness();
    h.meshWindow();
    h.transport.relayAnswer = { forwarded: false, reason: 'busy' };
    const p = h.sessions.open('bob-agent', { clientVersion: '0.6.0' }).session.id;
    const t = h.thread();
    h.sessions.take('bob-agent', p, t);
    h.reply(t);
    await h.outbox.flush();
    expect(recorded(h, 'relay').map((e) => e.stage)).toEqual(['sent', 'not_forwarded']);
  });

  it('a partial ack records failed not_acked for the message left out', async () => {
    const h = createBobDispatchHarness();
    const s = h.active();
    h.transport.respond.set(s, () => Promise.resolve([]));
    h.ask(h.thread());
    await h.outbox.flush();
    expect(recorded(h, 'delivery').map((e) => [e.stage, e.code])).toEqual([
      ['sent', undefined],
      ['failed', 'not_acked'],
    ]);
  });

  it('a message read through the inbox leaves no no_session memory', async () => {
    const h = createBobDispatchHarness();
    const s = h.sessions.open('bob-agent', { clientVersion: '0.2.0' }).session.id;
    const m = h.ask(h.thread());
    await h.outbox.flush();
    expect(h.dispatcher.notedCount).toBe(1);
    h.sessions.activate('bob-agent', s, 'x');
    readInbox(h.messaging as MessagingServiceImpl, 'bob-agent', s, 20, 5);
    await h.dispatcher.deliver('bob-agent', [m]);
    expect(h.dispatcher.notedCount).toBe(0);
  });

  it('a non-MeshError is internal, and telemetry.report failures are not recorded', async () => {
    const h = createBobDispatchHarness();
    const boom = async () => {
      throw new Error('boom');
    };
    const dispatch = createRpcRouter({
      index: () => h.ctx.index,
      handlers: { 'mesh.status': boom, 'telemetry.report': boom } as never,
      idempotency: new IdempotencyStore(h.ctx.db, h.clock),
      logger: h.ctx.logger,
      transaction: (fn) => h.ctx.db.transaction(fn),
      onError: (caller, method, code) =>
        hubRecorder(h.ctx)(caller, null, { kind: 'rpc', method, caller, code }),
    });
    await expect(dispatch({ caller: 'alice-agent', method: 'mesh.status' }, {})).rejects.toThrow();
    await expect(
      dispatch({ caller: 'alice-agent', method: 'telemetry.report' }, { events: [] }),
    ).rejects.toThrow();
    expect(recorded(h, 'rpc').map((e) => [e.method, e.code])).toEqual([
      ['mesh.status', 'internal'],
    ]);
  });

  it("the app's own router records a failed call", async () => {
    const hub = await createHub({
      loaded: testTeamConfig({ hub: { http: { enabled: false } } }),
      dataDir: ':memory:',
      nats: null,
      ports: { delivery: new MemoryPorts(), events: new MemoryPorts() },
      clock: new ManualClock('2026-10-16T09:00:00.000Z'),
      logger: createLogger('hub-test', { level: 'silent', destination: 'stderr' }),
    });
    await hub.start();
    const hello = (await hub.dispatch(
      { caller: 'bob-agent', method: 'session.hello' },
      { clientVersion: '0.7.0' },
    )) as { sessionId: string };
    const call = { caller: 'bob-agent', method: 'observe.timeline', session: hello.sessionId };
    await expect(hub.dispatch(call, {})).rejects.toMatchObject({ code: 'forbidden' });
    expect(recorded({ ctx: hub.context }, 'rpc').map((e) => [e.method, e.caller, e.code])).toEqual([
      ['observe.timeline', 'bob-agent', 'forbidden'],
    ]);
    await hub.stop();
  });
});
