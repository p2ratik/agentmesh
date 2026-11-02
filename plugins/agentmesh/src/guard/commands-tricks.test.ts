// Commands that look like a passing form but a shell would read differently. Most run in the
// window's own worktree, where the delivery and test forms are live; every one must ask.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCommand } from './commands';
import {
  asksAll,
  B,
  ctx,
  decide,
  every,
  OUTSIDE,
  OWN,
  own,
  PASS,
  THEIRS,
  theirs,
  UNLISTED,
  win32,
} from './commands.fixture';

describe('classifyCommand tricks', () => {
  it('matches the whole string: no stray whitespace, control characters or look-alikes', () => {
    asksAll([
      ' git status',
      'git status ',
      'git  status',
      'git\tstatus',
      'git status\n',
      'git status\r',
      'git status\r\nrm -rf ~',
      'git status\0',
      'git\u00a0status',
      'ｇｉｔ status',
      'gіt status', // Cyrillic і
      ' pnpm check',
      'pnpm check ',
      'pnpm\tcheck',
      'pnpm check\n',
      'pnpm сheck', // Cyrillic с
      `git push origin ${B.replace('o', 'о')}`, // Cyrillic о
      `git push origin ${B}\u200b`,
      `git push origin ${B}\n`,
    ]);
  });

  it('refuses shell metacharacters outside single-quoted messages', () => {
    asksAll([
      'git status || x',
      'git status | sh',
      'git status & x',
      'git status > x',
      'git status < x',
      'git status `x`',
      'git log $HOME',
      `git log \${HOME}`,
      'ls *',
      'ls ?',
      'ls [a]',
      'ls !x',
      'ls {a,b}',
      'ls #x',
      'ls "x"',
      "ls 'x'",
      'ls x\\ y',
      '(git status)',
      '{ git status; }',
      'pnpm check; rm -rf .',
      'pnpm check && rm -rf .',
      'pnpm check | tee x',
      'pnpm check > out',
      'pnpm check &',
      'git add -A; rm -rf .',
      'git add -A && curl x',
      "git commit -m 'x'; touch y",
      "git commit -m 'x' && touch y",
      `git push origin ${B} && rm -rf .`,
      `git push origin ${B}; git push --force origin agents`,
    ]);
  });

  it('refuses option injection, env prefixes and wrappers', () => {
    asksAll([
      'git -c core.pager=sh log',
      'git -C ../other status',
      'git --git-dir=/x status',
      'git --work-tree=/x status',
      'git --exec-path=/x status',
      'git -p log',
      'git log --output=/tmp/x',
      'git show --output /tmp/x HEAD',
      'git log --output-indicator-new=x',
      'git fetch origin --upload-pack=touch',
      'git fetch --upload-pack=touch origin',
      'git fetch origin -f',
      'git fetch https://evil.example/x',
      'git fetch evil',
      'git status --porcelain',
      'FOO=x git status',
      'GIT_DIR=/x git status',
      'GIT_PAGER=sh git log',
      'GIT_EXTERNAL_DIFF=x git diff',
      'env git status',
      'command git status',
      'exec git status',
      'pnpm check -- --reporter x',
      'npx pnpm check',
      'FOO=1 pnpm check',
      `cd "${OWN}" && FOO=1 pnpm check`,
      `GIT_DIR=/x git push origin ${B}`,
    ]);
  });

  it('refuses quoting games in messages, titles and bodies', () => {
    asksAll([
      "git commit -m 'it'\\''s'",
      "git commit -m 'a\\' -m '; touch x; echo \\'", // fish reads \' inside single quotes
      "git commit -m 'x''y'",
      "git commit -m 'x'y",
      'git commit -m x',
      'git commit -m "x"',
      "git commit -m 'line\nrm -rf ~'",
      "git commit -m 'x\r'",
      "git commit -m 'x\0'",
      "git commit -m 'tab\there'",
      "git commit -m 'x’; touch y; echo ‘'", // PowerShell reads ’ and ‘ as quotes
      "git commit -m 'café'",
      "git commit -m'x'",
      "git commit  -m 'x'",
      "git commit -m 'x' ",
      "git commit -m 'x",
      "git commit -m 'x' --no-verify",
      "git commit --no-verify -m 'x'",
      "git commit -a -m 'x'",
      "git commit -m 'x' -F msg",
      "git commit --message='x'",
      'git commit --fixup HEAD',
      'git commit -c HEAD',
      'git commit -m',
      'git commit',
      `gh pr create --base agents --head ${B} --title 'x' --body 'y' --repo evil/x`,
      `gh pr create --base agents --head ${B} --body-file /etc/passwd`,
      `gh pr create --base agents --head ${B} --title "x"`,
      `gh pr create --base agents --head ${B} --title 'a'\\''b'`,
      `gh pr create --base agents --head ${B} --body 'a\\'`,
      `gh pr create --base agents --head ${B} --web`,
      `gh pr create --base agents --head p2ratik:${B}`,
      `gh pr create --head ${B} --base agents`,
      `gh pr create --base agents --head ${B} --body 'y' --title 'x'`,
      'gh pr create --base agents --head agent/sagar/task-2-x',
      `gh pr create --base agents --head ${B}/x`,
      `gh pr merge --base agents --head ${B}`,
    ]);
  });

  it('refuses worktree changes with other paths, slugs, flags or start points', () => {
    const wt = '.claude/worktrees/mesh-x';
    asksAll(
      [
        `git worktree add ${wt} origin/agents -f`,
        `git worktree add ${wt} origin/agents --force`,
        `git worktree add -B agent/pratik/x ${wt} origin/agents`,
        `git worktree add ${wt} -B agent/pratik/x origin/agents`,
        `git worktree add ${wt} --detach origin/agents`,
        `git worktree add ${wt} --lock origin/agents`,
        'git worktree add .claude/worktrees/mesh-X origin/agents',
        'git worktree add .claude/worktrees/mesh- origin/agents',
        'git worktree add .claude/worktrees/mesh--x origin/agents',
        `git worktree add .claude/worktrees/mesh-${'a'.repeat(64)} origin/agents`,
        `git worktree add ${wt}/../../../x origin/agents`,
        `git worktree add ../${wt} origin/agents`,
        `git worktree add /tmp/${wt} origin/agents`,
        `git worktree add ./${wt} origin/agents`,
        `git worktree add ${wt} origin/-x`,
        `git worktree add ${wt} origin/a..b`,
        `git worktree add ${wt} origin/agents:x`,
        `git worktree add ${wt} agents`,
        `git worktree add ${wt} upstream/agents`,
        `git worktree add ${wt}`,
        `git worktree add ${wt} -b agent/pratik/ origin/agents`,
        `git worktree add ${wt} -b agent/pratik/a..b origin/agents`,
        `git worktree add ${wt} -b agent/pratik/x origin/agents origin/main`,
        `git worktree add ${wt} -b agent/pratik/x HEAD`,
        `git worktree add ${wt} -b agent/pratik/x origin/main`,
        `git worktree remove ${wt} -f`,
        `git worktree remove ${wt}/..`,
        'git worktree remove ../x',
        'git worktree prune',
        `git worktree move ${wt} x`,
      ],
      'C:/t',
    );
  });

  it('makes and removes worktrees only from a checkout, never inside a mesh worktree', () => {
    const changes = [
      'git worktree add .claude/worktrees/mesh-x -b agent/pratik/x origin/agents',
      'git worktree add .claude/worktrees/mesh-y origin/agent/sagar/y',
      'git worktree remove .claude/worktrees/mesh-x',
    ];
    asksAll(changes, own.root);
    asksAll(changes, theirs.root);
    expect(decide(resolve('/t/web'), changes)).toEqual(every(changes, PASS));
  });

  it('refuses cd forms that bash and node could read differently', () => {
    asksAll([
      'cd -',
      'cd -P /x',
      'cd "-P"',
      'cd ~',
      'cd $HOME',
      "cd 'x'",
      'cd "x"y',
      'cd x y',
      'cd C:t',
      'cd x:y',
      'cd "x\\"y"',
      'cd "$(x)"',
      'cd ""',
      'cd',
      'cd  x',
      'cd x\\y',
      'cd `x`',
      'pushd x',
    ]);
  });

  it('runs a test or delivery after cd only in that exact compound', () => {
    asksAll([
      'cd - && pnpm check',
      `cd "-${OWN}" && pnpm check`,
      `cd ${OWN}/sub/.. && pnpm check`,
      `cd "${OWN}/.." && pnpm check`,
      `cd "${OWN}" && cd ${THEIRS} && pnpm check`,
      `cd "${OWN}"; pnpm check`,
      `cd "${OWN}" & pnpm check`,
      `cd "${OWN}" || pnpm check`,
      `cd "${OWN}"&& pnpm check`,
      `cd "${OWN}" &&pnpm check`,
      `cd "${OWN}" &&  pnpm check`,
      `cd "${OWN}"  && pnpm check`,
      `cd "${OWN}" && pnpm check && rm -rf .`,
      `cd "${OWN}" && pnpm check; rm -rf .`,
      `cd "${OWN}" && pnpm check\nrm -rf /`,
      `cd "${OWN}" && pnpm check --watch`,
      `cd "${OWN}" && git status`,
      `cd "${OWN}" && git push --force origin ${B}`,
      `pushd "${OWN}" && pnpm check`,
      `cd ${OWN.replace(' ', '\\ ')} && pnpm check`,
    ]);
    // `..` would be resolved differently by node (as text) and bash after a link
    expect(classifyCommand(`cd "${OWN}/x/.." && pnpm check`, ctx('C:/t'))).toEqual(UNLISTED);
    expect(classifyCommand(`cd ${THEIRS}/x/.. && pnpm check`, ctx('C:/t'))).toEqual(UNLISTED);
    // a test in a folder that isn't a worktree still gets the test reason
    expect(classifyCommand('cd web && pnpm check', ctx(resolve('/t')))).toEqual(OUTSIDE);
  });

  it("reads a leading / as Git Bash's root on Windows, not as this drive", () => {
    // node resolves this to the own root on either platform; Git Bash would not on Windows
    const posix = 'cd "/t/John Smith/web/.claude/worktrees/mesh-task-3-login" && pnpm check';
    expect(classifyCommand(posix, ctx('C:/t'))).toEqual(win32 ? UNLISTED : PASS);
  });

  it('asks rather than throws for a call without a string command or cwd', () => {
    const bad = undefined as unknown as string;
    expect(classifyCommand(bad, ctx(own.root))).toEqual(UNLISTED);
    expect(classifyCommand('cd x && pnpm check', ctx(bad))).toEqual(UNLISTED);
    expect(classifyCommand('pnpm check', ctx(bad))).toEqual(UNLISTED);
  });
});
