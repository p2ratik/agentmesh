import { describe, expect, it } from 'vitest';
import type { CallContext, ThreadOwner } from '../../contracts';
import { createServiceHarness } from '../../testing/services';
import type { MessagingServiceImpl } from './messaging.service';
import { threadHandlers } from './thread.handlers';

describe('read state with sessions', () => {
  const setup = () => {
    const h = createServiceHarness();
    const owners = new Map<number, ThreadOwner>();
    h.messaging.setOwnerReader((threadId) => owners.get(threadId) ?? null);
    const handlers = threadHandlers(h.messaging as MessagingServiceImpl);
    const bob = { id: 'bob-agent', kind: 'agent' as const, roles: [] };
    const call = (session: string | null): CallContext => ({
      actor: bob,
      caller: bob,
      method: 'inbox.get',
      session,
      notes: [],
    });
    const thread = () =>
      h.messaging.createThread({
        kind: 'conversation',
        subject: 'x',
        createdBy: 'alice-agent',
        participants: ['bob-agent'],
      });
    const ask = (threadId: number, body: string) =>
      h.messaging.post({ threadId, senderId: 'alice-agent', kind: 'ask', body });
    return { h, owners, handlers, call, thread, ask };
  };

  it('a reply does not mark earlier unseen messages read', () => {
    const { h, thread, ask } = setup();
    const t = thread();
    ask(t.id, 'one');
    ask(t.id, 'two');
    h.messaging.post({ threadId: t.id, senderId: 'bob-agent', kind: 'reply', body: 're' });
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(1);
    expect(h.messaging.unreadThreadCount('alice-agent')).toBe(1);
  });

  it("reading another session's thread leaves it unread", async () => {
    const { h, owners, handlers, call, thread, ask } = setup();
    const t = thread();
    ask(t.id, 'one');
    owners.set(t.id, { sessionId: 'ses_1', liveness: 'live' });
    const params = { threadId: h.messaging.summary(t.id).id, limit: 30 };
    await handlers['thread.get'](params, call('ses_2'));
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(1);
    await handlers['thread.get'](params, call('ses_1'));
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it("the inbox shows this session's and unowned threads and names the rest", async () => {
    const { h, owners, handlers, call, thread, ask } = setup();
    const [mine, theirs, free] = [thread(), thread(), thread()] as const;
    for (const t of [mine, theirs, free]) ask(t.id, 'hi');
    owners.set(mine.id, { sessionId: 'ses_1', liveness: 'live' });
    owners.set(theirs.id, { sessionId: 'ses_2', liveness: 'away' });
    const inbox = await handlers['inbox.get']({ limit: 20, perThread: 5 }, call('ses_1'));
    const id = (t: { id: number }) => h.messaging.summary(t.id).id;
    expect(inbox.threads.map((x) => x.thread.id).sort()).toEqual([id(mine), id(free)].sort());
    expect(inbox.otherSessions).toEqual([
      { threadId: id(theirs), sessionId: 'ses_2', liveness: 'away' },
    ]);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(1);
    const all = await handlers['inbox.get']({ limit: 20, perThread: 5 }, call(null));
    expect(all.threads).toHaveLength(1);
    expect(all.otherSessions).toEqual([]);
  });

  it('the inbox lists threads needing action before FYI threads and flags FYI ones', async () => {
    const { h, handlers, call, thread, ask } = setup();
    const note = (threadId: number, body: string) =>
      h.messaging.post({
        threadId,
        senderId: 'alice-agent',
        kind: 'reply',
        body,
        deliveryClass: 'status',
      });
    const [asked, fyi, mixed] = [thread(), thread(), thread()] as const;
    ask(asked.id, 'q');
    note(fyi.id, 'started');
    note(mixed.id, 'started');
    ask(mixed.id, 'q');
    const inbox = await handlers['inbox.get']({ limit: 20, perThread: 5 }, call(null));
    const id = (t: { id: number }) => h.messaging.summary(t.id).id;
    expect(inbox.threads.map((x) => [x.thread.id, x.fyi])).toEqual([
      [id(mixed), false],
      [id(asked), false],
      [id(fyi), true],
    ]);
  });

  it('messages.seen never moves the cursor past an unread action', async () => {
    const { h, handlers, call, thread, ask } = setup();
    const t = thread();
    const note = (body: string) =>
      h.messaging.post({
        threadId: t.id,
        senderId: 'alice-agent',
        kind: 'reply',
        body,
        deliveryClass: 'status',
      }).message.id;
    const early = note('started');
    const action = ask(t.id, 'Handles 418?').message.id;
    const late = note('PR is up');
    const seen = (messageIds: string[]) => handlers['messages.seen']({ messageIds }, call('ses_1'));
    await seen([early, late]);
    const read = (id: string) => h.messaging.isRead('bob-agent', id);
    expect([read(early), read(action), read(late)]).toEqual([true, false, false]);
    // Once the action is read, the status after it can be.
    h.messaging.markRead('bob-agent', [action]);
    await seen([late]);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it("messages.seen marks only the caller's own deliveries read", async () => {
    const { h, handlers, call } = setup();
    const t = h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent', 'carol-agent'],
    });
    // Status items: the plugin reports only what rode along, and an action never reads as seen.
    const post = (to: string, body: string) =>
      h.messaging.post({
        threadId: t.id,
        senderId: 'alice-agent',
        kind: 'reply',
        body,
        to: [to],
        deliveryClass: 'status',
      }).message.id;
    const forBob = post('bob-agent', 'one');
    const forCarol = post('carol-agent', 'two');
    const seen = (messageIds: string[]) => handlers['messages.seen']({ messageIds }, call('ses_1'));
    // Carol's message is later in the thread: counting it would move Bob's cursor past his own.
    await seen([forCarol, 'msg-unknown']);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(1);
    expect(await seen([forBob])).toEqual({ ok: true });
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(0);
    expect(h.messaging.unreadThreadCount('carol-agent')).toBe(1);
  });
});
