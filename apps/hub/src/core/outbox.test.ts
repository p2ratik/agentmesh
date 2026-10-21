import type { MeshMessage } from '@agentmesh/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryReceipt } from '../ports';
import { createTestHarness, type TestHarness } from '../testing/harness';
import { createDispatchHarness } from '../testing/services';

const message = (id: string): MeshMessage => ({
  id,
  threadId: 'thr-1',
  kind: 'ask',
  from: { id: 'alice-agent', kind: 'agent', displayName: 'Alice' },
  to: ['bob-agent'],
  subject: 'hello',
  body: 'hi',
  status: null,
  trust: 'team',
  depth: 0,
  refs: {},
  createdAt: '2026-10-16T09:00:00.000Z',
});

const rows = ({ ctx }: TestHarness) =>
  ctx.db.all<{ message_id: string; state: string; attempts: number; last_error: string | null }>(
    'SELECT message_id, state, attempts, last_error FROM deliveries ORDER BY rowid',
  );

describe('SqliteOutbox', () => {
  it('publishes deliveries and events after flush', async () => {
    const { outbox, ports } = createTestHarness();
    outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    outbox.enqueueEvent('mesh.paused', { by: 'alice', reason: null });
    await outbox.flush();
    expect(ports.deliveredTo('bob-agent').map((m) => m.id)).toEqual(['msg-1']);
    expect(ports.events.map((e) => e.type)).toEqual(['mesh.paused']);
  });

  it('a failed delivery counts an attempt and retries the batch in order', async () => {
    const h = createTestHarness();
    const { outbox, ports } = h;
    outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    outbox.enqueueDelivery(message('msg-2'), 'bob-agent', false);
    ports.failNext = 1;
    await outbox.flush();
    expect(ports.deliveredTo('bob-agent')).toHaveLength(0);
    expect(rows(h)[0]).toMatchObject({ state: 'pending', attempts: 1, last_error: /simulated/ });
    await outbox.flush();
    expect(ports.deliveredTo('bob-agent').map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('returned ids are published and the rest stay pending', async () => {
    const h = createTestHarness(undefined, {
      deliver: async (_to, messages) => ({ delivered: messages.slice(0, 1).map((m) => m.id) }),
    });
    h.outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    h.outbox.enqueueDelivery(message('msg-2'), 'bob-agent', false);
    await h.outbox.flush();
    expect(rows(h)).toEqual([
      { message_id: 'msg-1', state: 'published', attempts: 1, last_error: null },
      { message_id: 'msg-2', state: 'pending', attempts: 0, last_error: null },
    ]);
  });

  it('a failing recipient does not delay another recipient', async () => {
    const { outbox, ports } = createTestHarness();
    outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    outbox.enqueueDelivery(message('msg-2'), 'carol-agent', false);
    ports.failNext = 1;
    ports.failRecipient = 'carol-agent';
    await outbox.flush();
    expect(ports.deliveredTo('bob-agent').map((m) => m.id)).toEqual(['msg-1']);
    expect(ports.deliveredTo('carol-agent')).toHaveLength(0);
    await outbox.flush();
    expect(ports.deliveredTo('carol-agent').map((m) => m.id)).toEqual(['msg-2']);
  });

  it('a slow recipient does not hold up another recipient', async () => {
    const slow = Promise.withResolvers<DeliveryReceipt>();
    const h = createTestHarness(undefined, {
      deliver: (to, messages) =>
        to === 'bob-agent'
          ? slow.promise
          : Promise.resolve({ delivered: messages.map((m) => m.id) }),
    });
    h.outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    h.outbox.enqueueDelivery(message('msg-2'), 'carol-agent', false);
    const flushing = h.outbox.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(rows(h).map((r) => r.state)).toEqual(['pending', 'published']);
    slow.resolve({ delivered: ['msg-1'] });
    await flushing;
    expect(rows(h).map((r) => r.state)).toEqual(['published', 'published']);
  });

  it('a recipient whose messages all wait neither spins the flush nor starves another', async () => {
    const h = createTestHarness(undefined, {
      deliver: async (to, messages) => ({
        delivered: to === 'bob-agent' ? [] : messages.map((m) => m.id),
      }),
    });
    for (let i = 1; i <= 200; i++)
      h.outbox.enqueueDelivery(message(`msg-${i}`), 'bob-agent', false);
    h.outbox.enqueueDelivery(message('msg-carol'), 'carol-agent', false);
    await h.outbox.flush();
    expect(rows(h).find((r) => r.message_id === 'msg-carol')?.state).toBe('published');
  });

  it('warns at most once a minute when a whole window of a recipient waits', async () => {
    const h = createTestHarness(undefined, { deliver: async () => ({ delivered: [] }) });
    const warn = vi.spyOn(h.ctx.logger, 'warn');
    const starved = () => warn.mock.calls.filter(([, msg]) => String(msg).includes('waits'));
    for (let i = 1; i <= 200; i++)
      h.outbox.enqueueDelivery(message(`msg-${i}`), 'bob-agent', false);
    await h.outbox.flush();
    expect(starved()).toEqual([
      [{ recipient: 'bob-agent', waiting: 200 }, expect.stringContaining('waits')],
    ]);
    await h.outbox.flush();
    expect(starved()).toHaveLength(1);
    h.clock.advance(60_000);
    await h.outbox.flush();
    expect(starved()).toHaveLength(2);
  });

  it('a failing commit marks nothing and retries', async () => {
    const h = createDispatchHarness();
    const s1 = h.sessions.open('bob-agent', { clientVersion: '0.2.0' }).session.id;
    h.sessions.activate('bob-agent', s1, 'web client');
    const t = h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    }).id;
    h.messaging.post({ threadId: t, senderId: 'alice-agent', kind: 'ask', body: 'Handles 418?' });
    vi.spyOn(h.messaging, 'markRead').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await h.outbox.flush();
    expect(rows(h)).toMatchObject([{ state: 'pending', attempts: 1, last_error: 'disk full' }]);
    expect(h.sessions.ownerOf(t, 'bob-agent')).toBeNull();
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(1);

    await h.outbox.flush();
    expect(h.transport.sends).toHaveLength(2);
    expect(rows(h)).toMatchObject([{ state: 'published' }]);
    expect(h.sessions.ownerOf(t, 'bob-agent')).toBe(s1);
    expect(h.messaging.unreadThreadCount('bob-agent')).toBe(0);
  });

  it('stores each row’s class and thread, and hands the class over with the message', async () => {
    const h = createTestHarness();
    h.outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false, 'status');
    h.outbox.enqueueDelivery(message('msg-2'), 'bob-agent', false);
    expect(h.ctx.db.all('SELECT message_id, class, thread_key FROM deliveries')).toEqual([
      { message_id: 'msg-1', class: 'status', thread_key: 'thr-1' },
      { message_id: 'msg-2', class: 'action', thread_key: 'thr-1' },
    ]);
    await h.outbox.flush();
    expect(h.ports.deliveredTo('bob-agent').map((m) => [m.id, m.class])).toEqual([
      ['msg-1', 'status'],
      ['msg-2', 'action'],
    ]);
  });

  it('holds deliveries until released', async () => {
    const { outbox, ports } = createTestHarness();
    outbox.enqueueDelivery(message('msg-1'), 'bob-agent', true);
    await outbox.flush();
    expect(ports.deliveries).toHaveLength(0);
    expect(outbox.heldCount()).toBe(1);
    expect(outbox.releaseHeld()).toBe(1);
    await outbox.flush();
    expect(ports.deliveredTo('bob-agent')).toHaveLength(1);
  });

  it('ignores duplicate deliveries of the same message to the same recipient', async () => {
    const { outbox, ports } = createTestHarness();
    outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    await outbox.flush();
    expect(ports.deliveries).toHaveLength(1);
  });
});
