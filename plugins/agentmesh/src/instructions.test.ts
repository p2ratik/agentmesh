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
      sessions: [],
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
    sessionId: 's-000000000001',
    reclaimed: [],
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
    expect(text.slice(0, 450)).toContain(
      '2 mesh thread(s) have unread messages; this session receives mesh work after your human runs /agentmesh:activate.',
    );
    expect(text).toContain('policy truncated');
  });

  // An inactive session is never told to act on mesh work (spec §2, §3): it only learns it exists.
  it('informs about unread threads instead of telling the session to read them', () => {
    for (const h of [hello('Be kind.', 2), null]) {
      const text = buildInstructions({ agentId: 'bob-agent', hello: h, problems: [] });
      expect(text).not.toContain('call inbox first');
      expect(text).not.toContain('Call inbox then');
      expect(text).toContain('Once this session is active, call inbox at session start');
    }
  });

  it('mentions /agentmesh:activate and stays under 4096', () => {
    const line =
      'This session receives mesh messages only after your human runs /agentmesh:activate; until then the tools still work and answers wait for this session.';
    for (const h of [hello('Escalate crucial decisions to aheen. '.repeat(300), 2), null]) {
      const text = buildInstructions({ agentId: 'bob-agent', hello: h, problems: [] });
      expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
      const [identity, next] = text.split('\n\n');
      expect(identity).toMatch(/^You are bob-agent/);
      expect(next).toBe(line);
    }
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
