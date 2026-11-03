import type { WindowPolicy } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import { windowRules } from './rules';

const policy: WindowPolicy = {
  version: 1,
  agentId: 'bob-agent',
  token: 'a'.repeat(32),
  ownBranchPrefix: 'agent/bob/',
  integrationBranch: 'agents',
  testCommands: ['pnpm install --frozen-lockfile', 'pnpm check'],
};

const NULL_PREFIX =
  "- Your branch template doesn't name you, so task worktrees, tests, commits, pushes and PRs all ask your human.";

describe('windowRules', () => {
  it('gives the mesh window its rules, in the forms the guard passes', () => {
    const lines = windowRules(policy).split('\n');
    expect(lines).toEqual([
      "AgentMesh: this session is bob-agent's mesh window. It takes the team's work: tasks, reviews and teammates' questions.",
      "- One task at a time, in order. Answer teammates' questions between steps.",
      '- Run commands with the Bash tool; PowerShell commands always ask your human here.',
      "- task_get names the task's checkout: the one git checkout in this folder whose origin matches the task's repo. Below, <checkout> is that absolute path and <worktree> a worktree's absolute path.",
      '- Chain a command after cd to an absolute path, one cd per call: cd "<checkout>" && <command>. git -C, a relative cd chain and a second cd ask.',
      "- Never clone a repo. If its checkout isn't in this folder, ask your human for the path.",
      '- Every task gets its own worktree: cd "<checkout>" && git fetch origin, then cd "<checkout>" && git worktree add .claude/worktrees/mesh-<task>-<slug> -b <suggested branch> --track origin/agents. Edits anywhere else are refused.',
      '- Reviews: read the diff without asking: cd "<checkout>" && git fetch origin, then cd "<checkout>" && git diff refs/remotes/origin/<base>...refs/remotes/origin/<branch>. Before you run the tests of a branch that isn\'t yours, reply in the task thread with status "working": "Running the tests on <branch> needs my human\'s approval; my verdict waits for it." Then fetch again, cd "<checkout>" && git worktree add .claude/worktrees/mesh-review-<task> refs/remotes/origin/<branch>, and run cd "<worktree>" && <test command>; your human approves the prompt.',
      '- Remove a worktree once its PR is merged, and a review worktree after review_submit: cd "<checkout>" && git worktree remove .claude/worktrees/mesh-<name>. If git refuses because of untracked files, tell your human (--force asks).',
      '- In a worktree on your own branch (agent/bob/…), run without asking: pnpm install --frozen-lockfile, pnpm check (as cd "<worktree>" && <test>, exactly as written). Any other test command asks.',
      "- From your own task worktree these run without asking, each as cd \"<worktree>\" && <command>: git add -A; git commit -m '<message without apostrophes>'; git push -u origin <branch>; gh pr create --base agents --head <branch> --title '<title>' --body '<body>'. Messages, titles and bodies are one line of plain ASCII with no apostrophe or backslash; heredoc or double-quoted commit messages ask.",
      '- Merging and anything not named here ask your human. Escalate before anything risky.',
      "- Never activate with pull: true here. If the test message doesn't arrive, call activate again.",
    ]);
  });

  it('says every test asks when the window lists no test commands', () => {
    const text = windowRules({ ...policy, testCommands: [] });
    expect(text).toContain('- Every test run asks your human: the window lists no test commands.');
    expect(text).not.toContain('run without asking: ');
    expect(text).toContain('From your own task worktree these run without asking');
  });

  it('says everything of your own asks with a null prefix, and claims nothing runs freely', () => {
    const text = windowRules({ ...policy, ownBranchPrefix: null });
    expect(text).toContain(NULL_PREFIX);
    expect(text).not.toContain('From your own task worktree');
    expect(text).not.toContain('run without asking: ');
  });

  it('falls back without a policy', () => {
    const text = windowRules(null);
    expect(text).toContain("your agent's mesh window");
    expect(text).toContain(
      "- The window's policy (~/.agentmesh/mesh-window.json) is missing or invalid, so every command asks your human.",
    );
    expect(text).toContain('--track origin/<integration branch>');
    expect(text).toContain(NULL_PREFIX);
    expect(text).not.toContain('From your own task worktree');
  });

  it('never names a short ref spelling a fetched tag could shadow', () => {
    for (const p of [policy, null]) {
      expect(windowRules(p)).not.toMatch(/ origin\/<(branch|base)>/);
    }
  });
});
