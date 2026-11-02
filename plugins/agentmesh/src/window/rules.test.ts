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
      "- Every piece of work gets its own worktree in the repo's checkout under this folder: cd to the checkout, run git fetch origin, then git worktree add .claude/worktrees/mesh-<task>-<slug> -b <suggested branch> --track origin/agents. Edits anywhere else are refused.",
      '- Reviews: read the diff without asking (git fetch origin, then git diff refs/remotes/origin/<base>...refs/remotes/origin/<branch>). Before you run the tests of a branch that isn\'t yours, reply in the task thread with status "working": "Running the tests on <branch> needs my human\'s approval; my verdict waits for it." Then run them in a review worktree (from the checkout, git worktree add .claude/worktrees/mesh-review-<task> refs/remotes/origin/<branch>) as cd <worktree> && <test command>; your human approves the prompt. Remove the review worktree after review_submit.',
      "- Never clone a repo. If its checkout isn't in this folder, ask your human for the path.",
      '- From the checkout, remove a worktree with git worktree remove .claude/worktrees/mesh-<name> once its PR is merged.',
      '- Commits, pushes and PRs ask your human; that is expected. Escalate before anything risky.',
      "- Never activate with pull: true here. If the test message doesn't arrive, call activate again.",
    ]) {
      expect(text).toContain(line);
    }
    // A fetched tag named origin/<branch> outranks the remote branch in that short spelling.
    expect(text).not.toMatch(/ origin\/<(branch|base)>/);
  });

  it('falls back without a policy', () => {
    const text = windowRules(null);
    expect(text).toContain("your agent's mesh window");
    expect(text).toContain('--track origin/<integration branch>');
  });
});
