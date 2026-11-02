import { describe, expect, it } from 'vitest';
import type { CallContext, ThreadOwner } from '../../contracts';
import { createServiceHarness } from '../../testing/services';
import { peekInbox } from './inbox';
import type { MessagingServiceImpl } from './messaging.service';
import { threadHandlers } from './thread.handlers';

describe('read state with sessions', () => {
  const setup = (mayTakeUnowned: () => boolean = () => true) => {
    const h = createServiceHarness(undefined, { mayTakeUnowned });
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

  it("an inactive session's inbox leaves unowned threads unread and counts them as waiting", async () => {
    const { h, handlers, call, thread, ask } = setup(() => false);
    for (let i = 0; i < 3; i++) ask(thread().id, 'hi');
    const inbox = await handlers['inbox.get']({ limit: 20, perThread: 5 }, call('ses_1'));
    expect(inbox.threads).toEqual([]);
    expect(inbox.waiting).toBe(3);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(3);
  });

  it('an inactive session still reads the threads it owns', async () => {
    const { h, owners, handlers, call, thread, ask } = setup(() => false);
    const t = thread();
    ask(t.id, 'hi');
    owners.set(t.id, { sessionId: 'ses_1', liveness: 'live' });
    const inbox = await handlers['inbox.get']({ limit: 20, perThread: 5 }, call('ses_1'));
    expect(inbox.threads.map((x) => x.thread.id)).toEqual([h.messaging.summary(t.id).id]);
  });

  it('peek counts only what this session may take and reports the rest as waiting', () => {
    const { h, owners, thread, ask } = setup(() => false);
    const [mine, a, b] = [thread(), thread(), thread()] as const;
    for (const t of [mine, a, b]) ask(t.id, 'hi');
    owners.set(mine.id, { sessionId: 'ses_1', liveness: 'live' });
    const peeked = peekInbox(h.messaging as MessagingServiceImpl, 'bob-agent', 'ses_1');
    expect([peeked.threads, peeked.waiting]).toEqual([1, 2]);
  });

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

  it('a session that does not own an unowned thread only looks at it', async () => {
    const { h, handlers, call, thread, ask } = setup();
    const t = thread();
    ask(t.id, 'one');
    await handlers['thread.get'](
      { threadId: h.messaging.summary(t.id).id, limit: 30 },
      call('ses_2'),
    );
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(1);
  });

  it('a caller without a session still marks what it reads', async () => {
    const { h, handlers, call, thread, ask } = setup();
    const t = thread();
    ask(t.id, 'one');
    await handlers['thread.get']({ threadId: h.messaging.summary(t.id).id, limit: 30 }, call(null));
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it('while paused, inbox and thread only look', async () => {
    const { h, owners, handlers, call, thread, ask } = setup();
    const t = thread();
    ask(t.id, 'one');
    owners.set(t.id, { sessionId: 'ses_1', liveness: 'live' });
    h.control.pause('aheen', null);
    const inbox = await handlers['inbox.get']({ limit: 20, perThread: 5 }, call('ses_1'));
    expect(inbox.paused).toBe(true);
    expect(inbox.threads.map((x) => x.thread.id)).toEqual([h.messaging.summary(t.id).id]);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(1);
    const looking = call('ses_1');
    await handlers['thread.get']({ threadId: h.messaging.summary(t.id).id, limit: 30 }, looking);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(1);
    expect(looking.notes).toContain('The mesh is paused: nothing was marked read.');
    const sessionless = call(null);
    await handlers['thread.get'](
      { threadId: h.messaging.summary(t.id).id, limit: 30 },
      sessionless,
    );
    expect(sessionless.notes).toEqual([]);
    h.control.pause('aheen', null);
    h.control.resume('aheen');
    const after = await handlers['inbox.get']({ limit: 20, perThread: 5 }, call('ses_1'));
    expect(after.paused).toBe(false);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it('while paused, an inbox read without a session still marks what it reads', async () => {
    const { h, handlers, call, thread, ask } = setup();
    const t = thread();
    ask(t.id, 'one');
    h.control.pause('aheen', null);
    const inbox = await handlers['inbox.get']({ limit: 20, perThread: 5 }, call(null));
    expect(inbox.paused).toBe(false);
    expect(inbox.threads).toHaveLength(1);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it('while paused, a caller without a session still marks what it reads', async () => {
    const { h, handlers, call, thread, ask } = setup();
    const t = thread();
    ask(t.id, 'one');
    h.control.pause('aheen', null);
    await handlers['thread.get']({ threadId: h.messaging.summary(t.id).id, limit: 30 }, call(null));
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
