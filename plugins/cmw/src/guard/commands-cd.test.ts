// Any listed command may follow `cd P && `, classified as if run from P. P must be absolute or
// start with ./, so bash never looks it up in CDPATH. A second cd and git -C ask.
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCommand } from './commands';
import {
  asksAll,
  ctx,
  decide,
  ELSEWHERE,
  every,
  OWN,
  PASS,
  policy,
  realContext,
  UNLISTED,
  win32,
} from './commands.fixture';
import type { PathOptions } from './paths';
import { fixture, put, slash } from './paths.fixture';

/** A checkout top in the stub fixture, as a command spells it (`G:/t/web` or `/t/web`). */
const WEB = slash(resolve('/t/web'));

describe('a listed command after cd', () => {
  it('is classified as if it ran in the cd target', () => {
    const chained = [
      `cd ${WEB} && git status`,
      `cd ${WEB} && git fetch origin`,
      `cd ${WEB} && pwd`,
      `cd ${WEB} && git worktree list`,
      `cd ${WEB} && ls -la src`,
      `cd ${WEB} && git diff refs/remotes/origin/agents...refs/remotes/origin/agent/sagar/y`,
      `cd ${WEB} && git worktree add .claude/worktrees/mesh-x -b agent/pratik/x --track origin/agents`,
      `cd ${WEB} && git worktree add .claude/worktrees/mesh-y refs/remotes/origin/agent/sagar/y`,
      `cd ${WEB} && git worktree remove .claude/worktrees/mesh-x`,
      `cd "${WEB}" && git fetch origin`,
      `cd "${OWN}" && pnpm check`,
      `cd "${OWN}" && git push -u origin agent/pratik/task-3-login`,
    ];
    expect(decide(ELSEWHERE, chained)).toEqual(every(chained, PASS));
    // the target decides: from a checkout top, chaining into a folder that isn't one asks
    const away = slash(ELSEWHERE);
    asksAll(
      [`cd ${away} && git diff a b`, `cd ${away} && git worktree remove .claude/worktrees/mesh-x`],
      resolve('/t/web'),
    );
  });

  it('asks for a relative, doubled or -C form', () => {
    asksAll(
      [
        'cd web && git fetch origin', // bash looks web up in CDPATH first
        'cd web && git status',
        'cd .claude/worktrees/mesh-x && git status',
        'cd ~ && git status',
        'cd .. && git status',
        `cd ${WEB}/../web && git status`,
        `cd ${WEB} && cd src && git status`,
        `cd ${WEB} && cd ${WEB} && git fetch origin`,
        `cd ${WEB} && cd`,
        `cd ${WEB} && pushd src`,
        'git -C web status',
        `git -C ${WEB} fetch origin`,
      ],
      resolve('/t'),
    );
    // ./ is relative, but bash never looks it up in CDPATH
    const dotted = [
      'cd ./web && git fetch origin',
      'cd ./web && git worktree remove .claude/worktrees/mesh-x',
    ];
    expect(decide(resolve('/t'), dotted)).toEqual(every(dotted, PASS));
    // a bare cd stays as it was: Claude Code reports the real cwd after it
    expect(decide(resolve('/t'), ['cd web', 'cd ..'])).toEqual(every(['cd web', 'cd ..'], PASS));
    // never a second cd, even one a team made its test command
    const odd = { policy: { ...policy, testCommands: ['cd packages'] } };
    expect(classifyCommand(`cd "${OWN}" && cd packages`, ctx(ELSEWHERE, odd))).toEqual(UNLISTED);
  });

  it('takes only the absolute spelling of this platform', () => {
    // a leading / is Git Bash's own root on Windows; X:/ is relative to bash elsewhere
    expect(classifyCommand('cd /t/web && git fetch origin', ctx(ELSEWHERE))).toEqual(
      win32 ? UNLISTED : PASS,
    );
    expect(classifyCommand('cd C:/t/web && git fetch origin', ctx(ELSEWHERE))).toEqual(
      win32 ? PASS : UNLISTED,
    );
  });
});

describe('a listed command after cd, with the real readers', () => {
  let base: string;
  let repo: string;
  let o: PathOptions;
  beforeEach(() => {
    ({ base, repo, o } = fixture());
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("passes the rules' checkout forms from the window folder", () => {
    for (const ref of ['agents', 'agent/sagar/y']) {
      put(
        join(repo, '.git', 'refs', 'remotes', 'origin', ...ref.split('/')),
        `${'a'.repeat(40)}\n`,
      );
    }
    const C = `"${slash(repo)}"`;
    const forms = [
      `cd ${C} && git fetch origin`,
      `cd ${C} && git worktree add .claude/worktrees/mesh-x -b agent/pratik/x --track origin/agents`,
      `cd ${C} && git worktree add .claude/worktrees/mesh-review-y refs/remotes/origin/agent/sagar/y`,
      `cd ${C} && git worktree remove .claude/worktrees/mesh-old`,
      `cd ${C} && git diff refs/remotes/origin/agents...refs/remotes/origin/agent/sagar/y`,
    ];
    const run = (cwd: string, list: string[]) =>
      Object.fromEntries(list.map((f) => [f, classifyCommand(f, realContext(o, cwd))]));
    expect(run(base, forms)).toEqual(every(forms, PASS));
    const asks = [
      `cd ${C} && cd src && git status`,
      'cd repo && git fetch origin',
      `git -C ${C} fetch origin`,
      `cd "${slash(join(repo, 'src'))}" && git diff a b`,
    ];
    expect(run(base, asks)).toEqual(every(asks, UNLISTED));
    expect(run(base, ['cd ./repo && git fetch origin'])).toEqual(
      every(['cd ./repo && git fetch origin'], PASS),
    );
  });
});
