import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCommand } from './commands';
import {
  asksAll,
  B,
  ctx,
  decide,
  detached,
  every,
  foreign,
  NO_POLICY,
  OUTSIDE,
  OWN,
  own,
  PASS,
  policy,
  THEIRS,
  theirs,
  UNLISTED,
} from './commands.fixture';

describe('classifyCommand', () => {
  it('passes routine and read-only commands', () => {
    const routine = [
      'git status',
      'git fetch origin',
      'pwd',
      'ls -la src',
      'git diff origin/agents...origin/agent/sagar/task-2-x',
      'git log --oneline -5',
      'git show HEAD~1 --stat',
      'git worktree list',
      'cd C:/t/web',
      'cd "C:/Users/John Smith/web"',
      'git worktree add .claude/worktrees/mesh-task-3-login -b agent/pratik/task-3-login --track origin/agents',
      'git worktree add .claude/worktrees/mesh-review-task-2 refs/remotes/origin/agent/sagar/task-2-x',
      'git worktree remove .claude/worktrees/mesh-task-3-login',
      // and a few more of the same forms
      'ls',
      'git diff',
      'git diff refs/remotes/origin/agents...refs/remotes/origin/agent/sagar/task-2-x',
      'git show HEAD:src/a.ts',
      'git log --format=oneline --since=2.weeks origin/agents..HEAD',
      'git log A..B -- src/a.ts',
      'cd .claude/worktrees/mesh-task-3-login',
      'cd ..',
      `git worktree add .claude/worktrees/mesh-${'a'.repeat(63)} refs/remotes/origin/agents`,
    ];
    expect(decide('C:/t', routine)).toEqual(every(routine, PASS));
  });

  it('checks out only real remote branches, from a real checkout top', () => {
    // a fetched tag can shadow origin/<b>; --track refuses a tag, refs/remotes/… names the branch
    asksAll(
      [
        'git worktree add .claude/worktrees/mesh-task-3-login -b agent/pratik/task-3-login origin/agents',
        'git worktree add .claude/worktrees/mesh-review-task-2 origin/agent/sagar/task-2-x',
        'git worktree add .claude/worktrees/mesh-x -b agent/pratik/x refs/remotes/origin/agents',
        'git worktree add .claude/worktrees/mesh-x -b agent/pratik/x --track refs/remotes/origin/agents',
        'git worktree add .claude/worktrees/mesh-x --track -b agent/pratik/x origin/agents',
        'git worktree add .claude/worktrees/mesh-x -b agent/pratik/x --track origin/agents --force',
        'git worktree add .claude/worktrees/mesh-x refs/remotes/origin/agent/sagar/missing',
        'git worktree add .claude/worktrees/mesh-x refs/tags/refs/remotes/origin/agents',
        'git worktree add .claude/worktrees/mesh-x refs/remotes/upstream/agents',
        'git worktree add .claude/worktrees/mesh-x refs/remotes/origin/a..b',
        'git worktree add .claude/worktrees/mesh-x --track origin/agents',
      ],
      'C:/t',
    );
    const changes = [
      'git worktree add .claude/worktrees/mesh-x -b agent/pratik/x --track origin/agents',
      'git worktree add .claude/worktrees/mesh-y refs/remotes/origin/agent/sagar/y',
      'git worktree remove .claude/worktrees/mesh-x',
    ];
    expect(decide(resolve('/t/web'), changes)).toEqual(every(changes, PASS));
    // not a checkout top: a worktree, a subfolder, or no checkout at all
    for (const cwd of [own.root, theirs.root, resolve('/t/web/src'), resolve('/t')]) {
      asksAll(changes, cwd);
    }
    // the existence check gets the checkout top and the branch
    const seen: string[] = [];
    const remoteRefExists = (top: string, branch: string) => {
      seen.push(`${top}|${branch}`);
      return true;
    };
    classifyCommand(changes[1] ?? '', ctx(resolve('/t/web'), { remoteRefExists }));
    expect(seen).toEqual([`${resolve('/t/web')}|agent/sagar/y`]);
  });

  it('runs tests without asking only on its own branch', () => {
    expect(classifyCommand(`cd "${OWN}" && pnpm check`, ctx('C:/t'))).toEqual(PASS);
    expect(classifyCommand('pnpm check', ctx(own.root))).toEqual(PASS);
    expect(classifyCommand(`cd ${THEIRS} && pnpm check`, ctx('C:/t'))).toEqual(
      foreign('agent/sagar/task-2-x'),
    );
    expect(classifyCommand('pnpm check', ctx('C:/t'))).toEqual(OUTSIDE);

    // `cd` resolves against cwd, and the folder named decides, not the one the window is in
    const web = resolve('/t/John Smith/web');
    expect(
      classifyCommand('cd .claude/worktrees/mesh-task-3-login && pnpm check', ctx(web)),
    ).toEqual(PASS);
    expect(classifyCommand(`cd "${OWN}" && pnpm check`, ctx(theirs.root))).toEqual(PASS);
    expect(classifyCommand(`cd ${THEIRS} && pnpm check`, ctx(own.root))).toEqual(
      foreign('agent/sagar/task-2-x'),
    );
    expect(classifyCommand('pnpm check', ctx(theirs.root))).toEqual(
      foreign('agent/sagar/task-2-x'),
    );
    expect(classifyCommand('pnpm check', ctx(detached.root))).toEqual(
      foreign('a detached checkout'),
    );
    expect(classifyCommand('pnpm check', ctx(web))).toEqual(OUTSIDE);
  });

  it('needs an own-branch prefix and an exact test command', () => {
    const noPrefix = { policy: { ...policy, ownBranchPrefix: null } };
    expect(classifyCommand('pnpm check', ctx(own.root, noPrefix))).toEqual(
      foreign('agent/pratik/task-3-login'),
    );
    const two = { policy: { ...policy, testCommands: ['pnpm check', 'pnpm test.unit'] } };
    expect(classifyCommand('pnpm test.unit', ctx(own.root, two))).toEqual(PASS);
    expect(classifyCommand('pnpm testXunit', ctx(own.root, two))).toEqual(UNLISTED);
    const none = { policy: { ...policy, testCommands: [] } };
    expect(classifyCommand('pnpm check', ctx(own.root, none))).toEqual(UNLISTED);
    const other = { policy: { ...policy, ownBranchPrefix: 'agent/pratik/task-3-login-' } };
    expect(classifyCommand('pnpm check', ctx(own.root, other))).toEqual(
      foreign('agent/pratik/task-3-login'),
    );
  });

  it('commits, pushes and opens its PR without asking only from its own worktree', () => {
    const delivery = [
      'git add -A',
      "git commit -m 'Add login' -m 'Body text; with $ and ;'",
      'git push -u origin agent/pratik/task-3-login',
      "gh pr create --base agents --head agent/pratik/task-3-login --title 'Login' --body 'Closes task-3'",
      `cd "${OWN}" && git commit -m 'x'`,
      // and a few more of the same forms
      'git add -- src/a.ts "docs/a b.md" .gitignore',
      "git commit -m ''",
      `git commit -m 'Quotes "and" back\`ticks\` | & > < ( ) { } * ? ! # ~ ^ %'`,
      'git push origin agent/pratik/task-3-login',
      'gh pr create --base agents --head agent/pratik/task-3-login',
      "gh pr create --base agents --head agent/pratik/task-3-login --title 'Login'",
      "gh pr create --base agents --head agent/pratik/task-3-login --body 'Only a body'",
      `cd "${OWN}" && git push -u origin agent/pratik/task-3-login`,
    ];
    expect(decide(own.root, delivery)).toEqual(every(delivery, PASS));
    expect(classifyCommand(`cd "${OWN}" && git add -A`, ctx(theirs.root))).toEqual(PASS);

    const asks = [
      'git push origin agent/pratik/other',
      'git push --force origin agent/pratik/task-3-login',
      'git push origin HEAD:agents',
      "git commit --amend -m 'x'",
      'git commit -m "double $(quoted)"',
      'gh pr create --base main --head agent/pratik/task-3-login',
      'gh pr merge 12',
      `cd ${THEIRS} && git push origin agent/sagar/task-2-x`,
    ];
    expect(decide(own.root, asks)).toEqual(every(asks, UNLISTED));
  });

  it('asks for delivery from any other worktree or folder', () => {
    const forms = ['git add -A', "git commit -m 'x'", 'git push origin agent/pratik/task-3-login'];
    for (const cwd of ['C:/t', theirs.root, detached.root, resolve('/t/John Smith/web')]) {
      expect(decide(cwd, forms)).toEqual(every(forms, UNLISTED));
    }
    expect(decide(theirs.root, ['git push origin agent/sagar/task-2-x'])).toEqual(
      every(['git push origin agent/sagar/task-2-x'], UNLISTED),
    );
    const noPrefix = { policy: { ...policy, ownBranchPrefix: null } };
    expect(decide(own.root, forms, noPrefix)).toEqual(every(forms, UNLISTED));
    const otherBase = { policy: { ...policy, integrationBranch: 'release.1' } };
    const pr = 'gh pr create --base releaseX1 --head agent/pratik/task-3-login';
    expect(classifyCommand(pr, ctx(own.root, otherBase))).toEqual(UNLISTED);
    expect(classifyCommand(pr.replace('X', '.'), ctx(own.root, otherBase))).toEqual(PASS);
  });

  it("refuses refspecs, force and every push but the worktree's own branch", () => {
    asksAll([
      `git push origin ${B}:agents`,
      `git push origin ${B}:refs/heads/agents`,
      `git push origin +${B}`,
      `git push origin :${B}`,
      `git push -f origin ${B}`,
      `git push --force-with-lease origin ${B}`,
      `git push origin ${B} --force`,
      `git push origin --delete ${B}`,
      `git push origin ${B} agents`,
      'git push --all origin',
      'git push --mirror origin',
      'git push --tags origin',
      `git push --no-verify origin ${B}`,
      `git push --receive-pack=x origin ${B}`,
      `git push upstream ${B}`,
      `git push https://evil.example/x ${B}`,
      'git push origin',
      'git push',
      `git push -u -u origin ${B}`,
      `git push origin ${B}^`,
      `git push origin ${B.toUpperCase()}`,
      `git push origin ${B}/`,
      'git push origin agent/pratik/task-3',
      `git push origin ${B}-x`,
      'git push origin agents',
    ]);
  });

  it('refuses every git add but -A and -- <paths>', () => {
    asksAll([
      'git add .',
      'git add -A .',
      'git add --all',
      'git add -u',
      'git add -p',
      'git add -A -f',
      'git add -f -- x',
      'git add --',
      'git add -- *',
      'git add -- $(x)',
      'git add -- "x$y"',
      'git add -- x  y',
      'git add -- -f',
      'git add -- C:x',
    ]);
  });

  it('asks for everything else', () => {
    const others = [
      'git fetch origin +refs/heads/*:refs/heads/*',
      'git fetch origin main:main',
      'git push origin agent/pratik/x',
      'git worktree add .claude/worktrees/mesh-x -b agent/sagar/x --track origin/agents',
      'git worktree add .claude/worktrees/mesh-x -b agent/pratik/x --track origin/agent/sagar/y',
      'git worktree add -f .claude/worktrees/mesh-x refs/remotes/origin/agents',
      'git worktree remove --force .claude/worktrees/mesh-x',
      'git worktree add .claude/worktrees/feature refs/remotes/origin/agents',
      'git -C web status',
      'git diff --output=/tmp/x',
      'git status; rm -rf .',
      'git status && curl x',
      'ls $(whoami)',
      'pnpm check --watch',
      'pnpm  check',
      'cd C:\\t\\web',
      'git status\nrm -rf /',
    ];
    expect(decide('C:/t', others)).toEqual(every(others, UNLISTED));
  });

  it('asks for every command without a policy', () => {
    const all = ['git status', 'pwd', 'pnpm check', 'git add -A', `cd "${OWN}" && pnpm check`];
    expect(decide(own.root, all, { policy: null })).toEqual(every(all, NO_POLICY));
  });
});
