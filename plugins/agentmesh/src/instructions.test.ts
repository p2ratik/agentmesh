import type { RpcResult } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { buildInstructions, MAX_INSTRUCTIONS } from './instructions';

function hello(policy: string, unreadThreads: number): RpcResult<'session.hello'> {
  return {
    self: {
      id: 'bob-agent',
      kind: 'agent',
      displayName: "Bob's Claude",
      owner: 'bob',
      status: 'online',
      statusNote: null,
      lastSeen: null,
      repo: null,
      branch: null,
      skills: [],
      areas: [],
      activeTasks: 0,
    },
    mesh: { name: 'acme', prefix: 'mesh' },
    policy: {
      instructions: policy,
      git: {
        integrationBranch: 'agents',
        protectedBranches: ['main'],
        branchTemplate: 'agent/{owner}/{task}-{slug}',
        agentsMayMergeInto: ['agents'],
      },
    },
    unreadThreads,
  } as RpcResult<'session.hello'>;
}

describe('buildInstructions', () => {
  it('fits Claude Code’s limit and keeps session state ahead of the long policy', () => {
    const text = buildInstructions({
      agentId: 'bob-agent',
      hello: hello('Escalate crucial decisions to aheen. '.repeat(300), 2),
      problems: [],
    });
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
    expect(text.slice(0, 400)).toContain('You have 2 thread(s) with unread messages');
    expect(text).toContain('policy truncated');
  });

  it('keeps a short policy whole', () => {
    const text = buildInstructions({
      agentId: 'bob-agent',
      hello: hello('Be kind.', 0),
      problems: [],
    });
    expect(text).toContain('Team policy:\nBe kind.');
    expect(text).not.toContain('unread');
  });
});
