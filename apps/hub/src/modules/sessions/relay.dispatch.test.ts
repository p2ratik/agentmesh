import { describe, expect, it } from 'vitest';
import { createBobDispatchHarness } from '../../testing/services';

/** Bob's mesh window at `version`, and a private session `p` (opened, never activated) owning `t`. */
function setup(version = '0.6.0') {
  const h = createBobDispatchHarness();
  const w = h.meshWindow(version);
  const p = h.sessions.open('bob-agent', { clientVersion: '0.6.0' }).session.id;
  const t = h.thread();
  h.sessions.take('bob-agent', p, t);
  /** Ids pushed to a session so far. */
  const pushedTo = (sessionId: string) =>
    h.transport.sends.filter((s) => s.sessionId === sessionId).flatMap((s) => s.ids);
  return { ...h, w, p, t, pushedTo };
}

describe('SessionDispatcher, the relay to the mesh window', () => {
  it('sends one pointer per thread and asking session, and leaves the replies pending', async () => {
    const h = setup();
    const [r1, r2] = [h.reply(h.t), h.reply(h.t)];
    await h.outbox.flush();
    await h.outbox.flush();
    expect(h.transport.relays).toEqual([
      {
        agentId: 'bob-agent',
        sessionId: h.w,
        relay: {
          type: 'relay',
          threadId: `thr-${h.t}`,
          messageId: r1.id,
          from: 'alice-agent',
          forSession: h.p,
        },
      },
    ]);
    expect(h.pending()).toEqual([r1.id, r2.id]);
    expect(h.pushedTo(h.w)).not.toContain(r1.id);
    expect(h.pushedTo(h.w)).not.toContain(r2.id);
  });

  it('does not resend after forwarded: false', async () => {
    const h = setup();
    h.transport.relayAnswer = { forwarded: false, reason: 'no record' };
    h.reply(h.t);
    for (let i = 0; i < 3; i += 1) await h.outbox.flush();
    expect(h.transport.relays).toHaveLength(1);
  });

  it("the owner's read publishes the replies, and the next reply relays again", async () => {
    const h = setup();
    const [r1, r2] = [h.reply(h.t), h.reply(h.t)];
    await h.outbox.flush();
    h.messaging.markRead('bob-agent', [r1.id, r2.id]);
    await h.outbox.flush();
    expect(h.pending()).toEqual([]);
    const r3 = h.reply(h.t);
    await h.outbox.flush();
    expect(h.transport.relays.map((r) => r.relay.messageId)).toEqual([r1.id, r3.id]);
  });

  it('a relay that never answers holds up no flush and is not sent again meanwhile', async () => {
    const h = setup();
    h.transport.relayAnswer = () => new Promise<never>(() => {});
    const r = h.reply(h.t);
    const q = h.ask(h.thread()); // unowned: goes to the window
    await h.outbox.flush();
    await h.outbox.flush();
    expect(h.pushedTo(h.w)).toContain(q.id);
    expect(h.pending()).toEqual([r.id]);
    expect(h.transport.relays).toHaveLength(1);
  });

  it('a failed relay leaves no mark: it goes again on the next flush, the window stays live', async () => {
    const h = setup();
    h.transport.relayAnswer = () => Promise.reject(new Error('timeout'));
    h.reply(h.t);
    await h.outbox.flush();
    expect(h.transport.relays).toHaveLength(1);
    await h.outbox.flush();
    expect(h.transport.relays).toHaveLength(2);
    expect(h.liveness(h.w)).toBe('live');
  });

  // Preflight F10: the first waiting message that relays, not the thread's first action.
  it('an ask waiting ahead of the reply does not stop its relay', async () => {
    const h = setup();
    h.ask(h.t);
    const r = h.reply(h.t);
    await h.outbox.flush();
    expect(h.transport.relays.map((x) => x.relay.messageId)).toEqual([r.id]);
  });

  it('a status reply alone wakes nobody', async () => {
    const h = setup();
    h.reply(h.t, 'info');
    await h.outbox.flush();
    expect(h.transport.relays).toEqual([]);
  });

  // Review focus 1: a window before 0.6.0 behaves exactly as today.
  it('a 0.5.0 window gets no relay', async () => {
    const h = setup('0.5.0');
    const r = h.reply(h.t);
    await h.outbox.flush();
    expect(h.transport.relays).toEqual([]);
    expect(h.transport.sends).toEqual([]);
    expect(h.pending()).toEqual([r.id]);
    expect(h.liveness(h.w)).toBe('live');
  });

  it('a paused mesh relays nothing', async () => {
    const h = setup();
    h.control.pause('alice', null);
    h.reply(h.t);
    await h.outbox.flush();
    expect(h.transport.relays).toEqual([]);
  });

  it('when the owner closes, the reply goes to the window', async () => {
    const h = setup();
    const r = h.reply(h.t);
    h.sessions.close('bob-agent', h.p);
    await h.outbox.flush();
    expect(h.pushedTo(h.w)).toContain(r.id);
    expect(h.transport.relays).toEqual([]);
  });
});
