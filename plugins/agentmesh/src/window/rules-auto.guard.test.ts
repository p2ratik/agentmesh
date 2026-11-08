// The auto-mode window's rules, each form filled in and run through the guard in auto mode, so the
// rules can't promise what the guard asks for, nor claim an ask the guard hands to auto mode.
import { rmSync } from 'node:fs';
import type { WindowPolicy } from '@agentmesh/common/window';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { checkout, checkRows, policy, type Row } from './rules.guard.fixture';

let base: string;
let C: string;
let W: string;
let R: string;

beforeEach(() => {
  ({ base, C, W, R } = checkout());
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const auto: WindowPolicy = { ...policy, mode: 'auto' };
const check = (p: WindowPolicy, rows: Row[]) => checkRows(base, p, rows, process.platform, 'auto');

describe('the auto-mode window rules, through the guard in auto mode', () => {
  it('pass and ask exactly as the rules say, with an own-branch prefix', () => {
    check(auto, [
      [
        'PowerShell commands get the same checks as Bash commands',
        'git status',
        'pass',
        'PowerShell',
      ],
      ['PowerShell commands get the same checks', 'git push origin main', 'ask', 'PowerShell'],
      ['run cd "<dir>" alone first', `cd ${C}`, 'pass'],
      ['cd "<checkout>" && git fetch origin', `cd ${C} && git fetch origin`, 'pass'],
      [
        'cd "<checkout>" && git worktree add .claude/worktrees/mesh-<task>-<slug> -b <suggested branch> --track origin/agents',
        `cd ${C} && git worktree add .claude/worktrees/mesh-task-3-x -b agent/bob/task-3-x --track origin/agents`,
        'pass',
      ],
      [
        'cd "<checkout>" && git diff refs/remotes/origin/<base>...refs/remotes/origin/<branch>',
        `cd ${C} && git diff refs/remotes/origin/agents...refs/remotes/origin/agent/alice/task-2-x`,
        'pass',
      ],
      ["Commands not named here go to auto mode's checks", `cd ${C} && gh pr diff 12`, 'pass'],
      ['cd "<worktree>" && <test command>; your human approves', `cd ${R} && pnpm check`, 'ask'],
      [
        "and any command in a worktree that isn't on your own branch",
        `cd ${R} && pnpm test`,
        'ask',
      ],
      [
        '(--force asks)',
        `cd ${C} && git worktree remove --force .claude/worktrees/mesh-review-task-2`,
        'ask',
      ],
      ['pnpm check (as cd "<worktree>" && <test>', `cd ${W} && pnpm check`, 'pass'],
      ["Other commands there go to auto mode's checks", `cd ${W} && pnpm test`, 'pass'],
      ["git commit -m '<message without apostrophes>'", `cd ${W} && git commit -m 'Add'`, 'pass'],
      ["other spellings go to auto mode's checks", `cd ${W} && git commit -m "Add"`, 'pass'],
      [
        'git push -u origin <branch>',
        `cd ${W} && git push -u origin agent/bob/task-1-login`,
        'pass',
      ],
      ['and any other push asks', `cd ${W} && git push origin agent/bob/task-1-login -f`, 'ask'],
      ["a push other than your own branch's form above", `cd ${W} && git push origin main`, 'ask'],
      ['merges', `cd ${W} && gh pr merge 12`, 'ask'],
      [
        'rebases other than onto refs/remotes/origin/agents',
        `cd ${W} && git rebase refs/remotes/origin/agents`,
        'pass',
      ],
      ['rebases other than onto', `cd ${W} && git rebase main`, 'ask'],
      ['branch deletes', `cd ${C} && git branch -D agent/bob/x`, 'ask'],
      ['hard resets', `cd ${W} && git reset --hard`, 'ask'],
      ['forced git commands (--force, -f)', `cd ${W} && git clean -fd`, 'ask'],
      ['git checkout -- or ., git restore', `cd ${W} && git restore src/a.ts`, 'ask'],
      ['git checkout -- or .', `cd ${W} && git checkout .`, 'ask'],
      ['git stash drop or clear', `cd ${W} && git stash drop`, 'ask'],
      [
        'infra commands (terraform, pulumi, kubectl, helm, az, aws, gcloud, docker push, ssh, scp, rsync)',
        'aws s3 ls',
        'ask',
      ],
      ['scp, rsync)', 'rsync -a . host:/srv', 'ask'],
      ['changes through gh (workflow run', 'gh workflow run deploy.yml', 'ask'],
      ['api writes', 'gh api -X DELETE repos/o/r/git/refs/heads/x', 'ask'],
      ['pr review --approve', 'gh pr review 12 --approve', 'ask'],
      ['a recursive search outside a task worktree', `cd ${C} && grep -rn TOKEN .`, 'ask'],
      ['Search code with the Grep tool or git grep', `cd ${W} && grep -rn login src`, 'pass'],
      ['Search code with the Grep tool or git grep', `cd ${C} && git grep -n TOKEN`, 'pass'],
      ['The guard refuses secret files', `cd ${W} && cat .env`, 'deny'],
      ['whole-environment dumps', 'Get-ChildItem env:', 'deny', 'PowerShell'],
      ['secret-named variables', 'echo $env:GH_TOKEN', 'deny', 'PowerShell'],
      ['credential commands', 'git credential fill', 'deny'],
    ]);
  });

  it('passes the listed forms the rules name, as in manual mode', () => {
    check(auto, [
      ['each as cd "<worktree>" && <command>: git add -A', `cd ${W} && git add -A`, 'pass'],
      [
        "gh pr create --base agents --head <branch> --title '<title>' --body '<body>'",
        `cd ${W} && gh pr create --base agents --head agent/bob/task-1-login --title 'L' --body 'B'`,
        'pass',
      ],
      [
        'cd "<checkout>" && git worktree add .claude/worktrees/mesh-review-<task> refs/remotes/origin/<branch>',
        `cd ${C} && git worktree add .claude/worktrees/mesh-review-task-9 refs/remotes/origin/agent/alice/task-2-x`,
        'pass',
      ],
      [
        'cd "<checkout>" && git worktree remove .claude/worktrees/mesh-<name>',
        `cd ${C} && git worktree remove .claude/worktrees/mesh-task-1-login`,
        'pass',
      ],
      ['cd "<checkout>" && git worktree list shows them', `cd ${C} && git worktree list`, 'pass'],
    ]);
  });

  it('asks in every worktree without a prefix, and hands own test runs to auto mode without test commands', () => {
    check({ ...auto, ownBranchPrefix: null }, [
      ['tests, commits, PRs and other commands in a task worktree', `cd ${W} && pnpm check`, 'ask'],
      ['commits, PRs and other commands', `cd ${W} && git commit -m 'Add'`, 'ask'],
      ['and other commands in a task worktree', `cd ${W} && pnpm test`, 'ask'],
      [
        'PRs and other commands',
        `cd ${W} && gh pr create --base agents --head agent/bob/task-1-login --title 'L'`,
        'ask',
      ],
      ['and every push, ask', `cd ${W} && git push -u origin agent/bob/task-1-login`, 'ask'],
    ]);
    check({ ...auto, testCommands: [] }, [
      ["test runs on your own branch go to auto mode's checks", `cd ${W} && pnpm check`, 'pass'],
    ]);
  });
});
