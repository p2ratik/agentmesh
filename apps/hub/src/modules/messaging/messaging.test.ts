import { HOUR_MS } from '@agentmesh/common';
import type { ReplyStatus } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { CallContext, ThreadOwner } from '../../contracts';
import { leaveTeam } from '../../testing/harness';
import { createServiceHarness } from '../../testing/services';
import { postLimitViolation } from './limits';
import type { MessagingServiceImpl } from './messaging.service';
import { sendHandlers } from './send.handlers';
import { threadHandlers } from './thread.handlers';

describe('postLimitViolation', () => {
  const limits = {
    maxThreadDepth: 3,
    perThreadPerHour: 2,
    perSenderPerDay: 5,
    dedupWindowSeconds: 60,
    maxBodyChars: 10,
  };
  const ok = { bodyChars: 5, threadLastHour: 0, senderLastDay: 0, duplicate: false };

  it('reports the first broken limit', () => {
    expect(postLimitViolation(ok, limits)).toBeNull();
    expect(postLimitViolation({ ...ok, bodyChars: 11 }, limits)?.code).toBe('invalid_request');
    expect(postLimitViolation({ ...ok, duplicate: true }, limits)?.code).toBe('duplicate');
    expect(postLimitViolation({ ...ok, threadLastHour: 2 }, limits)?.code).toBe('rate_limited');
    expect(postLimitViolation({ ...ok, senderLastDay: 5 }, limits)?.code).toBe('rate_limited');
  });
});

describe('MessagingService', () => {
  it('enforces thread rate limits and dedup for participants, not for the hub', () => {
    const h = createServiceHarness();
    h.ctx.index.config.limits.perThreadPerHour = 2;
    const thread = h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    });
    const post = (body: string, senderId = 'alice-agent', system = false) =>
      h.messaging.post({ threadId: thread.id, senderId, kind: 'ask', body, system });
    post('one');
    expect(() => post('one')).toThrow(/already sent/);
    post('two', 'bob-agent');
    expect(() => post('three')).toThrow(/per hour/);
    expect(() => post('hub notice', h.messaging.hubId, true)).not.toThrow();
    h.clock.advance(HOUR_MS + 1);
    expect(() => post('later')).not.toThrow();
  });

  it('cuts an oversize system post to the body limit, with a note; participants are refused', async () => {
    const h = createServiceHarness();
    const thread = h.messaging.createThread({
      kind: 'event',
      subject: 'CI failed',
      createdBy: h.messaging.hubId,
      participants: ['bob-agent'],
    });
    const post = (senderId: string, system: boolean) =>
      h.messaging.post({
        threadId: thread.id,
        senderId,
        kind: 'event',
        body: 'x'.repeat(40_000),
        system,
      });
    expect(() => post('alice-agent', false)).toThrow(/exceeds 32000/);
    const { body } = post(h.messaging.hubId, true).message;
    expect(body).toHaveLength(32_000);
    expect(body).toMatch(/truncated to 32000 characters/);
    expect((await h.drain()).get('bob-agent')?.[0]?.body).toBe(body);
  });

  it('stores explicit empty recipients without delivering, and skips humans', async () => {
    const h = createServiceHarness();
    const thread = h.messaging.createThread({
      kind: 'planning',
      subject: 'p',
      createdBy: 'alice',
      participants: ['alice-agent', 'bob-agent'],
    });
    const silent = h.messaging.post({
      threadId: thread.id,
      senderId: 'alice-agent',
      kind: 'plan',
      body: 'note',
      to: [],
    });
    expect(silent.deliveredTo).toEqual([]);
    const loud = h.messaging.post({
      threadId: thread.id,
      senderId: 'bob-agent',
      kind: 'reply',
      body: 'hi',
    });
    expect(loud.message.to.sort()).toEqual(['alice', 'alice-agent']);
    expect(loud.deliveredTo).toEqual(['alice-agent']);
    expect([...(await h.drain()).keys()]).toEqual(['alice-agent']);
  });

  it('skips participants who left the team instead of refusing the post', async () => {
    const h = createServiceHarness();
    const thread = h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent', 'carol-agent'],
    });
    leaveTeam(h.ctx, 'carol');
    const named = h.messaging.post({
      threadId: thread.id,
      senderId: h.messaging.hubId,
      kind: 'task',
      body: 'moved to review',
      to: ['bob-agent', 'carol-agent'],
      system: true,
    });
    expect(named.message.to).toEqual(['bob-agent']);
    const everyone = h.messaging.post({
      threadId: thread.id,
      senderId: 'alice-agent',
      kind: 'reply',
      body: 'hi',
    });
    expect(everyone.message.to).toEqual(['bob-agent']);
    expect([...(await h.drain()).keys()]).toEqual(['bob-agent']);
    expect(h.messaging.participants(thread.id)).toContain('carol-agent');
  });

  it('closes threads to further participant posts', () => {
    const h = createServiceHarness();
    const thread = h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    });
    h.messaging.closeThread(thread.id, 'alice-agent');
    expect(() =>
      h.messaging.post({ threadId: thread.id, senderId: 'bob-agent', kind: 'reply', body: 'late' }),
    ).toThrow(/closed/);
  });
});

describe('delivery classes', () => {
  const agent = (id: string): CallContext => {
    const actor = { id, kind: 'agent' as const, roles: [] };
    return { actor, caller: actor, method: 'message.send', session: null, notes: [] };
  };
  const classes = (h: ReturnType<typeof createServiceHarness>) =>
    h.ports.deliveries.map((d) => [d.recipientId, d.message.class]);

  it('a working or info reply is status for its recipients; an ask is action', async () => {
    const h = createServiceHarness();
    const send = sendHandlers(h.messaging as MessagingServiceImpl)['message.send'];
    const ask = await send(
      { kind: 'ask', body: 'Handles 418?', to: ['bob-agent'] },
      agent('alice-agent'),
    );
    const answer = (kind: 'ask' | 'reply', status: ReplyStatus) =>
      send({ kind, body: `${kind} ${status}`, threadId: ask.threadId, status }, agent('bob-agent'));
    const answers = [
      await answer('reply', 'working'),
      await answer('reply', 'info'),
      await answer('reply', 'answer'),
      // A question never goes quiet, whatever status it carries.
      await answer('ask', 'info'),
    ];
    expect(h.messaging.classFor(ask.messageId, 'bob-agent')).toBe('action');
    expect(answers.map((r) => h.messaging.classFor(r.messageId, 'alice-agent'))).toEqual([
      'status',
      'status',
      'action',
      'action',
    ]);
    await h.drain();
    expect(classes(h)).toEqual([
      ['bob-agent', 'action'],
      ['alice-agent', 'status'],
      ['alice-agent', 'status'],
      ['alice-agent', 'action'],
      ['alice-agent', 'action'],
    ]);
  });

  it('a per-recipient class function stores status only for the recipients it names', async () => {
    const h = createServiceHarness();
    const thread = h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent', 'carol-agent'],
    });
    const { message } = h.messaging.post({
      threadId: thread.id,
      senderId: 'alice-agent',
      kind: 'task',
      body: 'moved to review',
      deliveryClass: (id) => (id === 'bob-agent' ? 'status' : 'action'),
    });
    expect(h.messaging.classFor(message.id, 'bob-agent')).toBe('status');
    expect(h.messaging.classFor(message.id, 'carol-agent')).toBe('action');
    await h.drain();
    expect(classes(h).sort()).toEqual([
      ['bob-agent', 'status'],
      ['carol-agent', 'action'],
    ]);
  });
});

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
});
