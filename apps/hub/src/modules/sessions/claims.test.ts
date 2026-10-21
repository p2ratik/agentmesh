import { RPC_METHODS, type RpcMethodName } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { claimTargets, isClaiming } from './claims';

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

  it('claims nothing for malformed input', () => {
    expect(claimTargets('message.send', {}, { seq: 1 })).toEqual([]);
    expect(claimTargets('message.send', null, null)).toEqual([]);
    expect(claimTargets('message.send', undefined, 'x')).toEqual([]);
    expect(claimTargets('plan.contribute', null, null)).toEqual([]);
    expect(claimTargets('plan.contribute', { planId: 7 }, {})).toEqual([]);
  });

  it('isClaiming covers exactly the methods that can claim', () => {
    for (const method of Object.keys(RPC_METHODS) as RpcMethodName[]) {
      const claims = claimTargets(method, { planId: 'plan-1' }, { threadId: 'thr-1' });
      expect(isClaiming(method), method).toBe(claims.length > 0);
    }
  });
});
