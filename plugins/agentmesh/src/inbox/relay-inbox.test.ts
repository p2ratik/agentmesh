import type { SessionRelay } from '@agentmesh/protocol';
import { describe, expect, it, vi } from 'vitest';
import { harness, message, status } from './session-inbox.fixture';

const ID = 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9M';
const RELAY: SessionRelay = {
  type: 'relay',
  threadId: 'thr-12',
  messageId: ID,
  from: 'sagar-agent',
  forSession: 's-bbbbbbbbbbbb',
};

describe('a relay on the session subject', () => {
  it('hands a relay to onRelay and acks its answer, sharing nothing with deliveries', async () => {
    const onRelay = vi.fn(async () => ({ forwarded: true, reason: 'forwarded' }));
    const h = harness(undefined, { onRelay });
    await h.send({ type: 'deliver', messages: [status('s1', 'thr-3')] }).acked;
    const buffered = h.fyi.take();
    h.fyi.putBack(buffered);

    const ack = await h.send(RELAY).acked;
    expect(ack).toEqual({ delivered: [], forwarded: true, reason: 'forwarded' });
    expect(onRelay).toHaveBeenCalledExactlyOnceWith(RELAY);
    expect(h.pushed).toEqual([]);
    expect(h.fyi.take()).toEqual(buffered);
    expect(h.reported).toEqual([[]]);

    // The relay's message id is not remembered: the same id delivered later is still pushed.
    const later = await h.send({ type: 'deliver', messages: [message(ID, 'thr-12')] }).acked;
    expect(later.delivered).toEqual([ID]);
    expect(h.pushed.map((e) => e.meta.thread_id)).toEqual(['thr-12']);
  });
});
