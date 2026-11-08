import { describe, expect, it } from 'vitest';
import { harness, message, status } from './session-inbox.fixture';

const MSG = (n: number) => `msg-${String(n).padStart(26, '0')}`;
const stages = (h: ReturnType<typeof harness>) =>
  h.recorder.take(100).flatMap((e) => (e.kind === 'delivery' ? [[e.message, e.stage]] : []));

describe('recording deliveries', () => {
  it('a pushed delivery records received then pushed, with the thread id', async () => {
    const h = harness();
    await h.send({ type: 'deliver', messages: [message(MSG(1), 'thr-4')] }).acked;
    const events = h.recorder.take(100);
    expect(events.map((e) => e.kind === 'delivery' && e.stage)).toEqual(['received', 'pushed']);
    expect(events[0]).toMatchObject({ kind: 'delivery', message: MSG(1), thread: 'thr-4' });
    expect(JSON.stringify(events)).not.toContain('body');
  });

  it('a push that throws records push_failed', async () => {
    const h = harness('thr-4');
    await h.send({ type: 'deliver', messages: [message(MSG(1), 'thr-4')] }).acked;
    expect(stages(h)).toEqual([
      [MSG(1), 'received'],
      [MSG(1), 'push_failed'],
    ]);
  });

  it('a status item shown with an action push records pushed too', async () => {
    const h = harness();
    h.fyi.add([status(MSG(2), 'thr-9')]);
    await h.send({ type: 'deliver', messages: [message(MSG(1), 'thr-4')] }).acked;
    expect(stages(h)).toContainEqual([MSG(2), 'pushed']);
  });

  it('a redelivery records deduped, and a status item records held', async () => {
    const h = harness();
    const send = { type: 'deliver', messages: [message(MSG(1), 'thr-4'), status(MSG(2), 'thr-4')] };
    await h.send(send).acked;
    expect(stages(h)).toEqual([
      [MSG(1), 'received'],
      [MSG(2), 'received'],
      [MSG(2), 'held'],
      [MSG(1), 'pushed'],
      [MSG(2), 'pushed'],
    ]);
    await h.send(send).acked;
    expect(stages(h)).toEqual([
      [MSG(1), 'received'],
      [MSG(2), 'received'],
      [MSG(2), 'deduped'],
      [MSG(1), 'deduped'],
    ]);
  });
});
