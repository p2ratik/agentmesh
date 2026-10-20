import { HOUR_MS } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import { createServiceHarness } from '../../testing/services';
import { postLimitViolation } from './limits';

describe('postLimitViolation', () => {
  const limits = {
    maxThreadDepth: 3,
    perThreadPerHour: 2,
    perSenderPerDay: 5,
    dedupWindowSeconds: 60,
    maxBodyChars: 10,
    deliveryRetentionDays: 14,
  };
  const ok = { bodyChars: 5, threadLastHour: 0, senderLastDay: 0, duplicate: false };

  it('reports the first broken limit', () => {
    expect(postLimitViolation(ok, limits)).toBeNull();
    expect(postLimitViolation({ ...ok, bodyChars: 11 }, limits)?.code).toBe('invalid_request');
    expect(postLimitViolation({ ...ok, duplicate: true }, limits)?.code).toBe('duplicate');
    expect(postLimitViolation({ ...ok, threadLastHour: 2 }, limits)?.code).toBe('rate_limited');
    expect(postLimitViolation({ ...ok, senderLastDay: 5 }, limits)?.code).toBe('rate_limited');
  });
});

describe('MessagingService', () => {
  it('enforces thread rate limits and dedup for participants, not for the hub', () => {
    const h = createServiceHarness();
    h.ctx.index.config.limits.perThreadPerHour = 2;
    const thread = h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    });
    const post = (body: string, senderId = 'alice-agent', system = false) =>
      h.messaging.post({ threadId: thread.id, senderId, kind: 'ask', body, system });
    post('one');
    expect(() => post('one')).toThrow(/already sent/);
    post('two', 'bob-agent');
    expect(() => post('three')).toThrow(/per hour/);
    expect(() => post('hub notice', h.messaging.hubId, true)).not.toThrow();
    h.clock.advance(HOUR_MS + 1);
    expect(() => post('later')).not.toThrow();
  });

  it('stores explicit empty recipients without delivering, and skips humans', async () => {
    const h = createServiceHarness();
    const thread = h.messaging.createThread({
      kind: 'planning',
      subject: 'p',
      createdBy: 'alice',
      participants: ['alice-agent', 'bob-agent'],
    });
    const silent = h.messaging.post({
      threadId: thread.id,
      senderId: 'alice-agent',
      kind: 'plan',
      body: 'note',
      to: [],
    });
    expect(silent.deliveredTo).toEqual([]);
    const loud = h.messaging.post({
      threadId: thread.id,
      senderId: 'bob-agent',
      kind: 'reply',
      body: 'hi',
    });
    expect(loud.message.to.sort()).toEqual(['alice', 'alice-agent']);
    expect(loud.deliveredTo).toEqual(['alice-agent']);
    expect([...(await h.drain()).keys()]).toEqual(['alice-agent']);
  });

  it('closes threads to further participant posts', () => {
    const h = createServiceHarness();
    const thread = h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    });
    h.messaging.closeThread(thread.id, 'alice-agent');
    expect(() =>
      h.messaging.post({ threadId: thread.id, senderId: 'bob-agent', kind: 'reply', body: 'late' }),
    ).toThrow(/closed/);
  });
});
