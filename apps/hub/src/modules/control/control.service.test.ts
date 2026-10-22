import { describe, expect, it } from 'vitest';
import { createBobDispatchHarness as setup } from '../../testing/services';

/** The kill switch holds every delivery, including those queued before the pause. */
describe('ControlService pause', () => {
  it('a delivery queued before the pause waits until resume', async () => {
    const h = setup();
    const queued = h.ask(h.thread()); // bob has no active session yet
    await h.outbox.flush();
    h.control.pause('alice', 'incident');
    h.active();
    await h.outbox.flush();
    expect(h.transport.sends).toEqual([]);
    expect(h.ctx.outbox.heldCount()).toBe(1);
    expect(h.control.resume('alice')).toBe(1);
    await h.outbox.flush();
    expect(h.transport.sends.map((s) => s.ids)).toEqual([[queued.id]]);
  });

  it('nothing is carried while paused', async () => {
    const h = setup();
    const t = h.thread();
    const s1 = h.active();
    const status = h.note(t); // shown to s1, which dies before reporting it seen
    await h.outbox.flush();
    h.sessions.close('bob-agent', s1);
    const action = h.ask(t); // waits: bob has no active session
    await h.outbox.flush();
    h.control.pause('alice', null);
    h.active();
    await h.outbox.flush();
    expect(h.transport.sends.map((s) => s.ids)).toEqual([[status.id]]);
    h.control.resume('alice');
    await h.outbox.flush();
    expect(h.transport.sends.at(-1)?.ids).toEqual([status.id, action.id]);
  });
});
