import { RPC_METHODS, type RpcMethodName } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { claimsWhenInactive, claimTargets, isClaiming } from './claims';

describe('claimTargets', () => {
  it('claims the thread of a sent message', () => {
    expect(claimTargets('message.send', {}, { threadId: 'thr-3', seq: 1 })).toEqual([
      { kind: 'thread', key: 'thr-3' },
    ]);
  });

  it('claims the thread of a task action', () => {
    expect(claimTargets('task.act', {}, { threadId: 'thr-9' })).toEqual([
      { kind: 'thread', key: 'thr-9' },
    ]);
  });

  it('claims the plan a contribution is for', () => {
    expect(claimTargets('plan.contribute', { planId: 'plan-2' }, { round: 1 })).toEqual([
      { kind: 'plan', key: 'plan-2' },
    ]);
  });

  it('claims nothing for reads', () => {
    expect(claimTargets('task.get', { taskId: 'task-1' }, { threadId: 'thr-1' })).toEqual([]);
    expect(claimTargets('thread.get', {}, { threadId: 'thr-1' })).toEqual([]);
  });

  it('claims the action threads an inbox read returns, not the FYI ones', () => {
    const result = {
      threads: [
        { thread: { id: 'thr-1' }, fyi: false },
        { thread: { id: 'thr-2' }, fyi: true },
      ],
      paused: false,
    };
    expect(claimTargets('inbox.get', {}, result)).toEqual([{ kind: 'thread', key: 'thr-1' }]);
  });

  it("claims nothing for a closed asker's thread, as its push wouldn't", () => {
    const released = { bySession: 's-aaaaaaaaaaaa' };
    const result = {
      threads: [
        { thread: { id: 'thr-1' }, fyi: false, messages: [{ id: 'm1' }, { id: 'm2', released }] },
        { thread: { id: 'thr-2' }, fyi: false, messages: [null, 'x', { id: 'm3' }] },
      ],
      paused: false,
    };
    expect(claimTargets('inbox.get', {}, result)).toEqual([{ kind: 'thread', key: 'thr-2' }]);
  });

  it('claims nothing for a paused inbox read', () => {
    const result = { threads: [{ thread: { id: 'thr-1' }, fyi: false }], paused: true };
    expect(claimTargets('inbox.get', {}, result)).toEqual([]);
  });

  it('claims nothing for malformed input', () => {
    expect(claimTargets('inbox.get', {}, { threads: 'x' })).toEqual([]);
    expect(claimTargets('inbox.get', {}, { threads: [{ fyi: false }] })).toEqual([]);
    expect(claimTargets('inbox.get', {}, null)).toEqual([]);
    expect(claimTargets('message.send', {}, { seq: 1 })).toEqual([]);
    expect(claimTargets('message.send', null, null)).toEqual([]);
    expect(claimTargets('message.send', undefined, 'x')).toEqual([]);
    expect(claimTargets('plan.contribute', null, null)).toEqual([]);
    expect(claimTargets('plan.contribute', { planId: 7 }, {})).toEqual([]);
  });

  it('isClaiming covers exactly the methods that can claim', () => {
    for (const method of Object.keys(RPC_METHODS) as RpcMethodName[]) {
      const claims = claimTargets(
        method,
        { planId: 'plan-1' },
        { threadId: 'thr-1', threads: [{ thread: { id: 'thr-1' }, fyi: false }] },
      );
      expect(isClaiming(method), method).toBe(claims.length > 0);
    }
  });
});

describe('claimsWhenInactive', () => {
  const kinds = ['conversation', 'task', 'planning', 'escalation', 'event'] as const;
  it('lets an inactive session claim only conversations it sends in', () => {
    for (const m of ['message.send', 'escalate'] as const) {
      expect(claimsWhenInactive(m, 'conversation')).toBe(true);
      expect(claimsWhenInactive(m, 'escalation')).toBe(true);
    }
    for (const k of ['task', 'planning', 'event'] as const) {
      expect(claimsWhenInactive('message.send', k)).toBe(false);
      expect(claimsWhenInactive('escalate', k)).toBe(false);
    }
    for (const m of Object.keys(RPC_METHODS) as RpcMethodName[]) {
      if (m === 'message.send' || m === 'escalate') continue;
      for (const k of kinds) expect(claimsWhenInactive(m, k)).toBe(false);
    }
  });
});
