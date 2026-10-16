import type { MeshMessage } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '../testing/harness';

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

describe('SqliteOutbox', () => {
  it('publishes deliveries and events after flush', async () => {
    const { outbox, ports } = createTestHarness();
    outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    outbox.enqueueEvent('mesh.paused', { by: 'alice', reason: null });
    await outbox.flush();
    expect(ports.deliveredTo('bob-agent').map((m) => m.id)).toEqual(['msg-1']);
    expect(ports.events.map((e) => e.type)).toEqual(['mesh.paused']);
  });

  it('keeps per-recipient order when a publish fails and retries later', async () => {
    const { outbox, ports } = createTestHarness();
    outbox.enqueueDelivery(message('msg-1'), 'bob-agent', false);
    outbox.enqueueDelivery(message('msg-2'), 'bob-agent', false);
    ports.failNext = 1;
    await outbox.flush();
    expect(ports.deliveredTo('bob-agent')).toHaveLength(0);
    await outbox.flush();
    expect(ports.deliveredTo('bob-agent').map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
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
