import type { MessageRefs, SessionDelivery } from '@agentmesh/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createDispatchHarness } from '../../testing/services';
import { readInbox } from '../messaging/inbox';
import type { MessagingServiceImpl } from '../messaging/messaging.service';
import { SessionsServiceImpl } from './sessions.service';

function setup() {
  const h = createDispatchHarness();
  /** A bob-agent session, activated at the clock's current time. */
  const active = () => {
    const id = h.sessions.open('bob-agent', { clientVersion: '0.2.0' }).session.id;
    h.sessions.activate('bob-agent', id, 'web client');
    return id;
  };
  const thread = () =>
    h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    }).id;
  let n = 0;
  /** Posts an ask; returns it as the outbox hands it over. */
  const ask = (threadId: number, refs: MessageRefs = {}): SessionDelivery => ({
    ...h.messaging.post({ threadId, senderId: 'alice-agent', kind: 'ask', body: `q${++n}`, refs })
      .message,
    class: 'action',
  });
  const pending = () =>
    h.ctx.db
      .all<{ message_id: string }>(
        "SELECT message_id FROM deliveries WHERE state = 'pending' ORDER BY rowid",
      )
      .map((r) => r.message_id);
  const liveness = (sessionId: string) => h.sessions.verify('bob-agent', sessionId).liveness;
  return { ...h, active, thread, ask, pending, liveness };
}

describe('SessionDispatcher', () => {
  it('never delivers to an agent whose only session is inactive, nor routes for it', async () => {
    const { sessions, thread, ask, dispatcher, outbox, transport, pending } = setup();
    sessions.open('bob-agent', { clientVersion: '0.2.0' });
    const route = vi.spyOn(sessions, 'route');
    const m = ask(thread());
    expect((await dispatcher.deliver('bob-agent', [m])).delivered).toEqual([]);
    await outbox.flush();
    expect(transport.sends).toEqual([]);
    expect(pending()).toEqual([m.id]);
    expect(route).not.toHaveBeenCalled();
  });

  it('messages read through inbox are published without a push', async () => {
    const { sessions, thread, ask, outbox, transport, pending, messaging } = setup();
    const s1 = sessions.open('bob-agent', { clientVersion: '0.2.0' }).session.id;
    const [t1, t2] = [thread(), thread()];
    ask(t1);
    ask(t2);
    await outbox.flush();
    expect(pending()).toHaveLength(2);
    readInbox(messaging as MessagingServiceImpl, 'bob-agent', s1, 20, 5);
    sessions.activate('bob-agent', s1, 'web client');
    await outbox.flush();
    expect(transport.sends).toEqual([]);
    expect(pending()).toEqual([]);
    expect(sessions.ownerOf(t1, 'bob-agent')).toBeNull();
  });

  it('a new conversation sticks to the chosen session', async () => {
    const { active, thread, ask, clock, outbox, transport, sessions } = setup();
    const s1 = active();
    clock.advance(60 * 60_000);
    const s2 = active();
    const t = thread();
    const first = ask(t);
    await outbox.flush();
    expect(transport.sends).toEqual([{ agentId: 'bob-agent', sessionId: s1, ids: [first.id] }]);

    sessions.touch('bob-agent', s2, { repo: 'acme/web' });
    const next = ask(t, { repo: 'acme/web' });
    expect(sessions.route('bob-agent', next)).toMatchObject({
      sessionId: s1,
      reason: 'owns thread',
    });
    await outbox.flush();
    expect(transport.sends[1]).toMatchObject({ sessionId: s1, ids: [next.id] });
  });

  it('delivery marks the message read', async () => {
    const { active, thread, ask, outbox, messaging } = setup();
    active();
    ask(thread());
    expect(messaging.unreadThreadCount('bob-agent')).toBe(1);
    await outbox.flush();
    expect(messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it('a partly acked batch publishes the acked ids and keeps the rest', async () => {
    const { active, thread, ask, outbox, transport, pending } = setup();
    const s1 = active();
    const t = thread();
    const [m1, m2, m3] = [ask(t), ask(t), ask(t)];
    transport.respond.set(s1, async (messages) => messages.slice(0, 2).map((m) => m.id));
    await outbox.flush();
    expect(pending()).toEqual([m3.id]);
    transport.respond.delete(s1);
    await outbox.flush();
    expect(transport.sends.map((s) => s.ids)).toEqual([[m1.id, m2.id, m3.id], [m3.id]]);
    expect(pending()).toEqual([]);
  });

  it('an unreachable session goes away and its work waits', async () => {
    const { active, thread, ask, clock, outbox, transport, sessions, pending, liveness } = setup();
    const s1 = active();
    clock.advance(60_000);
    active();
    const t = thread();
    ask(t);
    await outbox.flush();
    transport.respond.set(s1, () => Promise.reject(new Error('timeout')));
    const next = ask(t);
    await outbox.flush();
    expect(liveness(s1)).toBe('away');
    expect(pending()).toEqual([next.id]);

    await outbox.flush();
    expect(transport.sends.map((s) => s.sessionId)).toEqual([s1, s1]);
    transport.respond.delete(s1);
    sessions.touch('bob-agent', s1);
    await outbox.flush();
    expect(transport.sends.at(-1)).toMatchObject({ sessionId: s1, ids: [next.id] });
    expect(pending()).toEqual([]);
  });

  it('waiting deliveries go out as soon as a session activates or comes back', async () => {
    const { sessions, thread, ask, outbox, transport, pending, liveness } = setup();
    /** Runs the flushes already scheduled, so only a new kick can deliver after this. */
    const settle = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await outbox.flush();
    };
    const s1 = sessions.open('bob-agent', { clientVersion: '0.2.0' }).session.id;
    const t = thread();
    ask(t);
    await settle();
    expect(transport.sends).toEqual([]);
    sessions.activate('bob-agent', s1, 'web client');
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));

    const goAway = async () => {
      transport.respond.set(s1, () => Promise.reject(new Error('timeout')));
      ask(t);
      await settle();
      expect(liveness(s1)).toBe('away');
      transport.respond.delete(s1);
    };
    await goAway();
    sessions.touch('bob-agent', s1);
    await vi.waitFor(() => expect(transport.sends).toHaveLength(3));
    await goAway();
    sessions.open('bob-agent', { clientVersion: '0.2.0', previousSessionId: s1 });
    await vi.waitFor(() => expect(transport.sends).toHaveLength(5));
    expect(pending()).toEqual([]);
  });

  it.each(['take', 'deactivate', 'bye', 'expiry'])(
    'work freed by %s goes out at once',
    async (how) => {
      const { active, thread, ask, clock, outbox, transport, sessions, ctx, liveness } = setup();
      const s1 = active();
      clock.advance(60_000);
      const s2 = active();
      const t = thread();
      ask(t);
      await outbox.flush();
      transport.respond.set(s1, () => Promise.reject(new Error('timeout')));
      const next = ask(t);
      await outbox.flush();
      expect(liveness(s1)).toBe('away');
      await new Promise((resolve) => setImmediate(resolve)); // let scheduled flushes run
      const sent = transport.sends.length;
      if (how === 'take') sessions.take('bob-agent', s2, t);
      if (how === 'deactivate') sessions.deactivate('bob-agent', s1);
      if (how === 'bye') sessions.close('bob-agent', s1);
      if (how === 'expiry') {
        clock.advance(ctx.loaded.config.presence.ownershipGraceMinutes * 60_000 + 1);
        sessions.touch('bob-agent', s2);
        expect(sessions.expire(clock.now()).closed).toBe(1);
      }
      await vi.waitFor(() =>
        expect(transport.sends.slice(sent)).toEqual([
          { agentId: 'bob-agent', sessionId: s2, ids: [next.id] },
        ]),
      );
    },
  );

  it('a dead session does not hold up other sessions', async () => {
    const { active, thread, ask, clock, dispatcher, transport, liveness } = setup();
    const s1 = active();
    clock.advance(60_000);
    const s2 = active();
    const m1 = ask(thread());
    const m2 = ask(thread(), { session: s2 });
    const dead = Promise.withResolvers<string[]>();
    transport.respond.set(s1, () => dead.promise);
    const delivering = dispatcher.deliver('bob-agent', [m1, m2]);
    expect(transport.sends.map((s) => s.sessionId)).toEqual([s1, s2]);
    dead.reject(new Error('timeout'));
    expect((await delivering).delivered).toEqual([m2.id]);
    expect(liveness(s1)).toBe('away');
  });

  it('a waiting message holds back the later messages of its thread', async () => {
    const { active, thread, ask, dispatcher, transport, sessions } = setup();
    active();
    const t = thread();
    const [m1, m2] = [ask(t), ask(t)];
    vi.spyOn(sessions, 'route').mockReturnValueOnce({ kind: 'wait', reason: 'held' });
    expect((await dispatcher.deliver('bob-agent', [m1, m2])).delivered).toEqual([]);
    expect(transport.sends).toEqual([]);
  });

  it('a new thread in one batch goes to one session', async () => {
    const { active, thread, ask, clock, outbox, transport, sessions } = setup();
    active();
    clock.advance(60_000);
    const s2 = active();
    const t = thread();
    const [m1, m2] = [ask(t, { session: s2 }), ask(t)];
    await outbox.flush();
    expect(transport.sends).toEqual([{ agentId: 'bob-agent', sessionId: s2, ids: [m1.id, m2.id] }]);
    expect(sessions.ownerOf(t, 'bob-agent')).toBe(s2);
  });

  it('a failed send holds back its whole new thread', async () => {
    const { active, thread, ask, clock, outbox, transport, messaging, pending } = setup();
    active();
    clock.advance(60_000);
    const s2 = active();
    const t = thread();
    const [m1, m2] = [ask(t, { session: s2 }), ask(t)];
    transport.respond.set(s2, () => Promise.reject(new Error('timeout')));
    await outbox.flush();
    expect(transport.sends.map((s) => s.sessionId)).toEqual([s2]);
    expect(pending()).toEqual([m1.id, m2.id]);
    expect(messaging.unreadThreadCount('bob-agent')).toBe(1);
  });

  it('routing survives a hub restart', async () => {
    const { active, thread, ask, clock, outbox, sessions, ctx, messaging } = setup();
    const s1 = active();
    clock.advance(60_000);
    const s2 = active();
    sessions.touch('bob-agent', s2, { repo: 'acme/web' });
    const t = thread();
    ask(t);
    await outbox.flush();
    const restarted = new SessionsServiceImpl(ctx, {
      messaging,
      locate: () => null,
      threadOf: () => null,
    });
    expect(restarted.route('bob-agent', ask(t, { repo: 'acme/web' }))).toMatchObject({
      kind: 'deliver',
      sessionId: s1,
      reason: 'owns thread',
    });
  });
});
