import type { WindowPolicy } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import { windowRules } from './rules';

const policy: WindowPolicy = {
  version: 1,
  agentId: 'bob-agent',
  token: 'a'.repeat(32),
  ownBranchPrefix: null,
  integrationBranch: 'agents',
  testCommands: [],
};

describe('windowRules', () => {
  it('gives the mesh window its rules', () => {
    const text = windowRules(policy);
    for (const line of [
      "AgentMesh: this session is bob-agent's mesh window. It takes the team's work: tasks, reviews and teammates' questions.",
      "- One task at a time, in order. Answer teammates' questions between steps.",
      "- Every piece of work gets its own worktree in the repo's checkout under this folder: cd to the checkout, run git fetch origin, then git worktree add .claude/worktrees/mesh-<task>-<slug> -b <suggested branch> origin/agents. Edits anywhere else are refused.",
      "- Never clone a repo. If its checkout isn't in this folder, ask your human for the path.",
      '- Remove a worktree with git worktree remove .claude/worktrees/mesh-<name> once its PR is merged.',
      '- Commits, pushes and PRs ask your human; that is expected. Escalate before anything risky.',
      "- Never activate with pull: true here. If the test message doesn't arrive, call activate again.",
    ]) {
      expect(text).toContain(line);
    }
  });

  it('falls back without a policy', () => {
    const text = windowRules(null);
    expect(text).toContain("your agent's mesh window");
    expect(text).toContain('origin/<integration branch>');
  });
});
