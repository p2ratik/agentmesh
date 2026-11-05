import type { RpcResult } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { CallContext } from '../../contracts';
import { createBobDispatchHarness } from '../../testing/services';
import type { MessagingServiceImpl } from '../messaging/messaging.service';
import { threadHandlers } from '../messaging/thread.handlers';

/**
 * Bob's 0.6.0 mesh window `w`, and a private session `p` that asked in `t` and closed. An inbox
 * read runs its handler and `recordClaims` in one transaction, as the router does.
 */
function setup() {
  const h = createBobDispatchHarness();
  const w = h.meshWindow();
  const p = h.sessions.open('bob-agent', { clientVersion: '0.6.0' }).session.id;
  const t = h.thread();
  h.sessions.take('bob-agent', p, t);
  h.sessions.close('bob-agent', p);
  const released = { bySession: p, closedAt: h.clock.now().toISOString(), claudeSessionId: null };
  const handlers = threadHandlers(h.messaging as MessagingServiceImpl);
  const bob = { id: 'bob-agent', kind: 'agent' as const, roles: [] };
  const call = (method: 'inbox.get' | 'thread.get', session: string): CallContext => ({
    actor: bob,
    caller: bob,
    method,
    session,
    notes: [],
  });
  const inbox = (session = w) =>
    h.ctx.db.transaction(() => {
      const params = { limit: 20, perThread: 5 };
      const result = handlers['inbox.get'](
        params,
        call('inbox.get', session),
      ) as RpcResult<'inbox.get'>;
      h.sessions.recordClaims(call('inbox.get', session), 'inbox.get', params, result);
      return result;
    });
  const thread = (session = w) =>
    handlers['thread.get'](
      { threadId: `thr-${t}`, limit: 50 },
      call('thread.get', session),
    ) as RpcResult<'thread.get'>;
  const rows = () => h.ctx.db.all('SELECT thread_id, released_by FROM orphan_decisions');
  const notices = () =>
    h.ctx.db.all("SELECT body FROM messages WHERE thread_id = $t AND kind = 'system'", { t });
  const pushed = () => h.transport.sends.flatMap((s) => s.ids);
  return { ...h, w, p, t, released, inbox, thread, rows, notices, pushed };
}

// Final review (parked, made worse): the window's first contact with the answer is a read.
describe("a closed asker's answer read before its push", () => {
  it('an inbox read records it once, posts one notice, marks it closed and claims nothing', async () => {
    const h = setup();
    const r = h.reply(h.t);
    const result = h.inbox();
    expect(result.threads[0]?.messages.map((m) => [m.id, m.released])).toEqual([
      [r.id, h.released],
    ]);
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBeNull();
    expect(h.rows()).toEqual([{ thread_id: h.t, released_by: h.p }]);
    expect(h.notices()).toHaveLength(1);
    await h.outbox.flush();
    expect(h.pushed()).not.toContain(r.id);
    expect(h.rows()).toHaveLength(1);
    expect(h.notices()).toHaveLength(1);
  });

  it('a thread read records it and marks it; the push that follows adds nothing', async () => {
    const h = setup();
    const r = h.reply(h.t);
    expect(h.thread().messages.map((m) => [m.id, m.released])).toEqual([[r.id, h.released]]);
    expect(h.rows()).toEqual([{ thread_id: h.t, released_by: h.p }]);
    await h.outbox.flush();
    expect(h.pushed()).toContain(r.id);
    expect(h.rows()).toHaveLength(1);
    expect(h.notices()).toHaveLength(1);
  });

  it("the owner's own decision, read first, starts no timer", () => {
    const h = setup();
    h.messaging.post({ threadId: h.t, senderId: 'bob', kind: 'reply', body: 'drop it' });
    expect(h.inbox().threads[0]?.messages[0]?.released).toEqual(h.released);
    expect(h.rows()).toEqual([]);
    expect(h.notices()).toEqual([]);
  });

  it('a paused read shows the mark but hands nothing over', () => {
    const h = setup();
    h.control.pause('alice', null);
    h.reply(h.t);
    expect(h.inbox().threads[0]?.messages[0]?.released).toEqual(h.released);
    expect(h.thread().messages[0]?.released).toEqual(h.released);
    expect(h.rows()).toEqual([]);
  });

  it('with no window, another session reads it as plain work and claims it, as its push would', () => {
    const h = setup();
    const a = h.active();
    h.sessions.deactivate('bob-agent', h.w);
    h.reply(h.t);
    expect(h.inbox(a).threads[0]?.messages[0]).not.toHaveProperty('released');
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBe(a);
    expect(h.rows()).toEqual([]);
  });
});
