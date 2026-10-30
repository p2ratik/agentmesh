import { describe, expect, it } from 'vitest';
import { createBobDispatchHarness } from '../../testing/services';
import { peekInbox, readInbox } from '../messaging/inbox';
import type { MessagingServiceImpl } from '../messaging/messaging.service';

/** Bob's Claude Desktop window: active in pull mode (ADR 0008). */
function setup() {
  const h = createBobDispatchHarness();
  const pull = () => {
    const id = h.sessions.open('bob-agent', { clientVersion: '0.4.1' }).session.id;
    h.sessions.activate('bob-agent', id, 'desktop', 'pull');
    return id;
  };
  const messaging = h.messaging as MessagingServiceImpl;
  const peek = (sessionId: string) => peekInbox(messaging, 'bob-agent', sessionId);
  return { ...h, pull, peek, messaging };
}

describe('pull sessions', () => {
  // A delivery is acked as read and claims its thread, so a pull session must never get one.
  it('get no deliveries: their work waits unread, peek counts it, inbox reads it', async () => {
    const { pull, thread, ask, note, outbox, transport, pending, peek, messaging } = setup();
    const s = pull();
    const [t1, t2, t3] = [thread(), thread(), thread()];
    const asked = ask(t1);
    const noted = note(t2);
    const external = messaging.post({
      threadId: t3,
      senderId: messaging.hubId,
      kind: 'event',
      body: 'CI failed',
      trust: 'external',
      to: ['bob-agent'],
    }).message;
    await outbox.flush();
    expect(transport.sends).toEqual([]);
    expect(pending()).toEqual([asked.id, noted.id, external.id]);

    expect(peek(s)).toEqual({
      threads: 3,
      actions: 2,
      from: [messaging.hubId, 'alice-agent'],
      external: true,
    });
    expect(peek(s).threads).toBe(3); // peeking marks nothing read

    readInbox(messaging, 'bob-agent', s, 20, 5);
    expect(peek(s)).toEqual({ threads: 0, actions: 0, from: [], external: false });
    await outbox.flush();
    expect(transport.sends).toEqual([]);
    expect(pending()).toEqual([]);
  });

  it('keep the threads they own, even with a push session open', async () => {
    const { pull, active, thread, ask, outbox, transport, sessions, peek } = setup();
    const s1 = pull();
    const t = thread();
    sessions.take('bob-agent', s1, t);
    active();
    const m = ask(t);
    expect(sessions.route('bob-agent', m)).toEqual({
      kind: 'wait',
      reason: `held for ${s1} (pull)`,
    });
    await outbox.flush();
    expect(transport.sends).toEqual([]);
    expect(peek(s1).threads).toBe(1);
  });

  it('leave unowned work to a push session of the same agent', async () => {
    const { pull, active, thread, ask, outbox, transport } = setup();
    pull();
    const s2 = active();
    const m = ask(thread());
    await outbox.flush();
    expect(transport.sends).toEqual([{ agentId: 'bob-agent', sessionId: s2, ids: [m.id] }]);
  });
});
