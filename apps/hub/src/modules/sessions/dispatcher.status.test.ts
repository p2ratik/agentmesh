import type { SessionDelivery } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { FakeTransport } from '../../testing/fakes';
import { createBobDispatchHarness as setup } from '../../testing/services';
import { readInbox } from '../messaging/inbox';
import type { MessagingServiceImpl } from '../messaging/messaging.service';

/** The last batch a session was sent, as [id, class] pairs. */
const lastBatch = (transport: FakeTransport) =>
  transport.batches.at(-1)?.map((m) => [m.id, m.class]);

describe('SessionDispatcher and status items', () => {
  it('a status delivery is published but stays unread until seen', async () => {
    const { active, thread, note, outbox, transport, pending, messaging } = setup();
    const s1 = active();
    const m = note(thread());
    await outbox.flush();
    expect(transport.sends).toEqual([{ agentId: 'bob-agent', sessionId: s1, ids: [m.id] }]);
    expect(pending()).toEqual([]);
    expect(messaging.unreadThreadCount('bob-agent')).toBe(1);
    messaging.markSeen('bob-agent', [m.id]);
    expect(messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it('a status message never claims its thread; a later action in the same batch does', async () => {
    const { active, thread, note, ask, outbox, transport, sessions, messaging } = setup();
    const s1 = active();
    const t = thread();
    const first = note(t);
    await outbox.flush();
    expect(sessions.ownerOf(t, 'bob-agent')).toBeNull();
    const [status, action] = [note(t), ask(t)];
    await outbox.flush();
    // The first status is still unread, so it rides along.
    expect(transport.sends.at(-1)).toEqual({
      agentId: 'bob-agent',
      sessionId: s1,
      ids: [first.id, status.id, action.id],
    });
    expect(sessions.ownerOf(t, 'bob-agent')).toBe(s1);
    expect(messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it("a status item delivered to a session that then dies stays in the inbox's FYI section", async () => {
    const { active, thread, note, outbox, transport, sessions, messaging } = setup();
    const s1 = active();
    const m = note(thread());
    await outbox.flush();
    expect(transport.sends.map((s) => s.ids)).toEqual([[m.id]]);
    sessions.close('bob-agent', s1);
    const inbox = readInbox(messaging as MessagingServiceImpl, 'bob-agent', active(), 20, 5);
    expect(inbox.threads.map((x) => [x.messages.map((y) => y.id), x.fyi])).toEqual([
      [[m.id], true],
    ]);
  });

  it('a status left with a dead session rides along with the next action in its thread', async () => {
    const { active, thread, note, ask, outbox, transport, sessions } = setup();
    const t = thread();
    const s1 = active();
    const status = note(t);
    await outbox.flush();
    sessions.close('bob-agent', s1);
    const s2 = active();
    const next = ask(t);
    await outbox.flush();
    expect(transport.sends.at(-1)?.sessionId).toBe(s2);
    expect(lastBatch(transport)).toEqual([
      [status.id, 'status'],
      [next.id, 'action'],
    ]);
  });

  it('a status left with a dead session rides along with a later status in its thread', async () => {
    const { active, thread, note, outbox, transport, sessions, messaging } = setup();
    const t = thread();
    const s1 = active();
    const first = note(t);
    await outbox.flush();
    sessions.close('bob-agent', s1);
    active();
    const second = note(t);
    await outbox.flush();
    expect(lastBatch(transport)).toEqual([
      [first.id, 'status'],
      [second.id, 'status'],
    ]);
    // The new session reports the later one seen; the cursor passes the first, which it showed too.
    messaging.markSeen('bob-agent', [second.id]);
    expect(messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it("a thread's carried statuses are not returned as delivered and claim nothing", async () => {
    const { active, thread, note, outbox, dispatcher, transport, sessions, messaging } = setup();
    active();
    const t = thread();
    const first = note(t);
    await outbox.flush();
    const second: SessionDelivery = { ...note(t), class: 'status' };
    const delivering = dispatcher.deliver('bob-agent', [second]);
    expect(lastBatch(transport)).toEqual([
      [first.id, 'status'],
      [second.id, 'status'],
    ]);
    const receipt = await delivering;
    expect(receipt.delivered).toEqual([second.id]);
    receipt.commit?.();
    expect(sessions.ownerOf(t, 'bob-agent')).toBeNull();
    expect(messaging.unreadThreadCount('bob-agent')).toBe(1);
  });
});
