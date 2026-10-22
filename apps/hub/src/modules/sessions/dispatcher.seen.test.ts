import { describe, expect, it } from 'vitest';
import { createBobDispatchHarness as setup } from '../../testing/services';

type Harness = ReturnType<typeof setup>;

/** The session acks all it gets and, like the plugin, reports the status items it got as seen. */
function plugin(h: Harness, sessionId: string): void {
  h.transport.respond.set(sessionId, async (messages) => {
    const shown = messages.filter((m) => m.class === 'status').map((m) => m.id);
    if (shown.length > 0) h.messaging.markSeen('bob-agent', shown);
    return messages.map((m) => m.id);
  });
}

/** Ids of every action item pushed so far. */
const pushedActions = (h: Harness) =>
  new Set(
    h.transport.batches
      .flat()
      .filter((m) => m.class === 'action')
      .map((m) => m.id),
  );

/** A hub notice to bob (system posts skip the per-thread rate limit). */
const notice = (h: Harness, threadId: number, cls: 'action' | 'status') =>
  h.messaging.post({
    threadId,
    senderId: 'alice-agent',
    kind: cls === 'action' ? 'ask' : 'reply',
    body: cls,
    system: true,
    deliveryClass: cls,
  }).message;

/** A status reported seen never makes an unpushed action count as read (spec §4). */
describe('SessionDispatcher, messages.seen and unpushed actions', () => {
  it('an action held by a pause is pushed after resume', async () => {
    const h = setup();
    const t = h.thread();
    const before = h.ask(t); // queued while bob has no active session
    await h.outbox.flush();
    h.control.pause('alice', 'incident');
    const held = h.ask(t);
    h.note(t);
    plugin(h, h.active());
    await h.outbox.flush();
    h.control.resume('alice');
    await h.outbox.flush();
    expect(pushedActions(h)).toEqual(new Set([before.id, held.id]));
  });

  it('the 51st action of a thread is pushed though a newer status was seen', async () => {
    const h = setup();
    const t = h.thread();
    const actions = Array.from({ length: 51 }, () => notice(h, t, 'action').id);
    notice(h, t, 'status'); // the 52nd row: past the first window of 50
    plugin(h, h.active());
    await h.outbox.flush();
    expect(pushedActions(h)).toEqual(new Set(actions));
  });

  it('an action whose push failed is delivered later though a status after it was seen', async () => {
    const h = setup();
    const s1 = h.active();
    const [t, u] = [h.thread(), h.thread()];
    const failed = h.ask(t);
    const status = h.note(t);
    h.ask(u);
    // Thread u's push carried the FYI footer and was shown; thread t's push failed.
    h.transport.respond.set(s1, async (messages) => {
      h.messaging.markSeen('bob-agent', [status.id]);
      return messages.filter((m) => m.id !== failed.id).map((m) => m.id);
    });
    await h.outbox.flush();
    expect(h.pending()).toEqual([failed.id]);
    h.transport.respond.delete(s1);
    await h.outbox.flush();
    expect(h.transport.sends).toHaveLength(2);
    expect(h.transport.sends[1]?.ids).toContain(failed.id);
    expect(h.pending()).toEqual([]);
  });

  it('a delivery carries only the status items older than its newest message in their thread', async () => {
    const h = setup();
    h.active();
    const t = h.thread();
    const older = h.note(t);
    const first = h.ask(t);
    h.note(t); // newer than the batch: held or out of its window, so never shown early
    await h.dispatcher.deliver('bob-agent', [{ ...first, class: 'action' }]);
    expect(h.transport.sends.map((s) => s.ids)).toEqual([[older.id, first.id]]);
  });
});
