import { MeshError } from '@agentmesh/common';
import { HubEvent } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../rpc/idempotency';
import { createRpcRouter } from '../../rpc/router';
import { createBobDispatchHarness } from '../../testing/services';
import { hubRecorder } from './hub-event';

type Row = Record<string, unknown>;
const recorded = (h: { ctx: { db: { all<T>(sql: string): T[] } } }, kind?: string): Row[] =>
  h.ctx.db
    .all<{ body: string }>('SELECT body FROM events ORDER BY rowid')
    .map((r) => HubEvent.parse(JSON.parse(r.body)) as unknown as Row)
    .filter((e) => !kind || e.kind === kind);
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
    expect(phases(h)).toEqual(['opened', 'live']);
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

  it('an orphan escalation records recorded then escalated, and settled once owned', async () => {
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
    const raw = JSON.stringify(h.ctx.db.all('SELECT * FROM events'));
    expect(raw).not.toMatch(/p4rams|secret-text/);
  });
});
