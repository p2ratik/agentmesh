import { describe, expect, it, vi } from 'vitest';
import { harness, message, status } from './session-inbox.fixture';

describe('runSessionInbox', () => {
  it('pushes one event per thread and acks every pushed id', async () => {
    const h = harness();
    expect(h.subs[0]?.subject).toBe('mesh.session.alice-agent.s-aaaaaaaaaaaa');
    const batch = [message('m1', 'thr-1'), message('m2', 'thr-2'), message('m3', 'thr-1')];
    const ack = await h.send({ type: 'deliver', messages: batch }).acked;
    expect(h.pushed.map((e) => [e.meta.thread_id, e.meta.count])).toEqual([
      ['thr-1', '2'],
      ['thr-2', undefined],
    ]);
    expect([...ack.delivered].sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('does not ack messages whose push failed', async () => {
    const h = harness('thr-2');
    const batch = [message('m1', 'thr-1'), message('m2', 'thr-2'), message('m3', 'thr-2')];
    const ack = await h.send({ type: 'deliver', messages: batch }).acked;
    expect(ack.delivered).toEqual(['m1']);
  });

  it('acks a redelivered id without pushing it again', async () => {
    const h = harness();
    await h.send({ type: 'deliver', messages: [message('m1', 'thr-1')] }).acked;
    const ack = await h.send({
      type: 'deliver',
      messages: [message('m1', 'thr-1'), message('m2', 'thr-1')],
    }).acked;
    expect(h.pushed.map((e) => e.meta.message_id)).toEqual(['m1', 'm2']);
    expect(h.pushed[1]?.content).toBe('│ body m2');
    expect(ack.delivered).toEqual(['m1', 'm2']);
  });

  it('status items are acked without a channel event', async () => {
    const h = harness();
    const ack = await h.send({
      type: 'deliver',
      messages: [status('s1', 'thr-1'), status('s2', 'thr-2')],
    }).acked;
    expect(ack.delivered).toEqual(['s1', 's2']);
    expect(h.pushed).toEqual([]);
    expect(h.reported.flat()).toEqual([]);
    expect(h.fyi.take().items.map((m) => m.id)).toEqual(['s1', 's2']);
  });

  it('the next action push carries the buffered FYIs and reports them seen', async () => {
    const h = harness();
    await h.send({ type: 'deliver', messages: [status('s1', 'thr-1')] }).acked;
    const ack = await h.send({
      type: 'deliver',
      messages: [status('s2', 'thr-2'), message('a1', 'thr-2'), message('a2', 'thr-3')],
    }).acked;
    expect(h.pushed.map((e) => e.content)).toEqual([
      '│ body a1\n\nFYI (2):\n· thr-1 «Render queue» body s1\n· thr-2 «Render queue» body s2',
      '│ body a2',
    ]);
    expect(ack.delivered).toEqual(['s2', 'a1', 'a2']);
    expect(h.reported.flat()).toEqual(['s1', 's2']);
    expect(h.fyi.take().items.map((m) => m.id)).toEqual([]);
  });

  it('a redelivered status id is acked without buffering it twice', async () => {
    const h = harness();
    await h.send({ type: 'deliver', messages: [status('s1', 'thr-1')] }).acked;
    // The hub carries a thread's unread status along with each later delivery in it.
    await h.send({ type: 'deliver', messages: [status('s1', 'thr-1'), message('a1', 'thr-1')] })
      .acked;
    const ack = await h.send({
      type: 'deliver',
      messages: [status('s1', 'thr-1'), message('a2', 'thr-1')],
    }).acked;
    expect(h.pushed.map((e) => e.content)).toEqual([
      '│ body a1\n\nFYI (1):\n· thr-1 «Render queue» body s1',
      '│ body a2',
    ]);
    expect(ack.delivered).toEqual(['s1', 'a2']);
    expect(h.reported.flat()).toEqual(['s1']);
  });

  it('a thread that lost FYIs to the cap is not reported seen, so they stay unread', async () => {
    const h = harness();
    // 51 status items: the oldest, from thr-1, is dropped; thr-1 still has two shown.
    const kept = Array.from({ length: 50 }, (_, i) =>
      status(`s${i}`, i === 0 || i === 49 ? 'thr-1' : 'thr-2'),
    );
    const messages = [status('x', 'thr-1'), ...kept, message('a1', 'thr-3')];
    await h.send({ type: 'deliver', messages }).acked;
    expect(h.pushed[0]?.content).toMatch(/\n· …and 1 more: call inbox$/);
    expect(h.reported.flat()).toEqual(kept.slice(1, 49).map((m) => m.id));
  });

  it('FYIs taken for a failed push ride along with the next one', async () => {
    const h = harness('thr-1');
    await h.send({ type: 'deliver', messages: [status('s1', 'thr-1'), message('a1', 'thr-1')] })
      .acked;
    expect(h.pushed).toEqual([]);
    expect(h.reported.flat()).toEqual([]);
    await h.send({ type: 'deliver', messages: [message('a2', 'thr-2')] }).acked;
    expect(h.pushed.map((e) => e.content)).toEqual([
      '│ body a2\n\nFYI (1):\n· thr-1 «Render queue» body s1',
    ]);
    expect(h.reported.flat()).toEqual(['s1']);
  });

  it('a team push carrying an external FYI is external', async () => {
    const h = harness();
    const alarm = { ...status('s1', 'thr-1'), subject: 'AWS alarm', trust: 'external' as const };
    await h.send({ type: 'deliver', messages: [alarm, message('a1', 'thr-2')] }).acked;
    expect(h.pushed[0]?.meta.trust).toBe('external');
    expect(h.pushed[0]?.content).toContain('· thr-1 🌐 external content «AWS alarm» body s1');
  });

  it('calls onExpired for an expiry notice', async () => {
    const h = harness();
    const { respond } = h.send({ type: 'expired' });
    await vi.waitFor(() => expect(h.onExpired).toHaveBeenCalledOnce());
    expect(respond).not.toHaveBeenCalled();
  });

  it('pushes an activation check with its code, then acks it', async () => {
    const h = harness();
    const ack = await h.send({ type: 'check', code: 'K7Q2ZP' }).acked;
    expect(h.checks).toEqual(['K7Q2ZP']);
    expect(ack).toEqual({ delivered: [] });
  });

  it('logs a failed subscription and retries it when asked', () => {
    const h = harness();
    h.subs[0]?.callback(new Error('Permissions Violation for Subscription'), {});
    expect(h.error).toHaveBeenCalledOnce();
    h.inbox.retryFailed();
    expect(h.subs.map((s) => s.subject)).toEqual([
      'mesh.session.alice-agent.s-aaaaaaaaaaaa',
      'mesh.session.alice-agent.s-aaaaaaaaaaaa',
    ]);
    h.inbox.retryFailed();
    expect(h.subs).toHaveLength(2);
  });

  it('ignores malformed payloads', async () => {
    const h = harness();
    const bad = [h.send('not json'), h.send({ type: 'deliver', messages: [] })];
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(2));
    for (const { respond } of bad) expect(respond).not.toHaveBeenCalled();
    expect(h.pushed).toEqual([]);
  });

  it('moves to the current session on resubscribe and lets go on stop', () => {
    const h = harness();
    (h.hub as { sessionId: string }).sessionId = 's-bbbbbbbbbbbb';
    h.inbox.resubscribe();
    expect(h.subs.map((s) => [s.subject, s.closed])).toEqual([
      ['mesh.session.alice-agent.s-aaaaaaaaaaaa', true],
      ['mesh.session.alice-agent.s-bbbbbbbbbbbb', false],
    ]);
    expect(h.onListening).toHaveBeenCalledTimes(2);
    h.inbox.stop();
    h.inbox.resubscribe();
    expect(h.subs.map((s) => s.closed)).toEqual([true, true]);
    expect(h.onListening).toHaveBeenCalledTimes(2);
  });
});
