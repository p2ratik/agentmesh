// Auto mode and where a command runs: a teammate's worktree named or reached in any way asks, a
// recursive search passes only inside a mesh worktree, and a call with no cwd asks.
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { policy } from './commands.fixture';
import { decide, type GuardContext } from './decide';
import { fixture, mesh, slash } from './paths.fixture';

let base: string;
let repo: string;
let W: string;
let R: string;
let ctx: GuardContext;

beforeEach(() => {
  const f = fixture();
  ({ base, repo } = f);
  ctx = { marked: true, policy, home: f.o.home, platform: f.o.platform };
  W = mesh(repo, 'mesh-task-1-a', 'agent/pratik/task-1-a');
  R = mesh(repo, 'mesh-review-2', 'agent/bob/task-2-x');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const run = (command: string, cwd = repo, tool = 'Bash', mode = 'auto') =>
  decide({ tool_name: tool, tool_input: { command }, cwd, permission_mode: mode }, ctx);

const PASS = { kind: 'pass' };
const THEIRS = {
  kind: 'ask',
  reason:
    "mesh window: agent/bob/task-2-x isn't your branch, so running its tests needs your human's approval",
  code: 'command.needs_approval',
};
const SEARCH = {
  kind: 'ask',
  reason:
    'mesh window: a recursive search outside a task worktree can read untracked secrets, so your human decides; search with the Grep tool or git grep',
  code: 'command.risky',
};

/** Each way of running a command in a worktree, for the worktree named `name` at `dir`. */
const reaches = (name: string, dir: string): [string, string?][] => [
  [`cd .claude/worktrees/${name} && pnpm check`],
  [`cd .claude/worktrees/${name} && pnpm vitest run`],
  [`(cd "${slash(dir)}" && pnpm vitest run)`],
  [`cd "${slash(dir)}" && cd . && pnpm vitest run`],
  [`pnpm --dir .claude/worktrees/${name} vitest run`],
  [`cd "${slash(dir)}"; pnpm vitest run`],
  [`Set-Location "${slash(dir)}"; pnpm vitest run`, 'PowerShell'],
  [`bash -c "cd ${slash(dir)}; pnpm vitest run"`],
];

describe("auto mode, a teammate's worktree", () => {
  it('asks however the command reaches it', () => {
    const rows = reaches('mesh-review-2', R);
    expect(rows.map(([c, tool]) => [c, run(c, repo, tool)])).toEqual(
      rows.map(([c]) => [c, THEIRS]),
    );
    // a relative cd from the window's own worktree, with ..
    expect(run('cd ../mesh-review-2 && pnpm vitest run', W)).toEqual(THEIRS);
  });

  it('passes the same forms in the window’s own worktree', () => {
    const rows = reaches('mesh-task-1-a', W);
    expect(rows.map(([c, tool]) => [c, run(c, repo, tool)])).toEqual(rows.map(([c]) => [c, PASS]));
  });
});

describe('auto mode, a recursive search', () => {
  it('passes inside a mesh worktree, naming nothing outside it', () => {
    expect(run(`cd "${slash(W)}" && grep -rn foo .`)).toEqual(PASS);
    expect(run('grep -rn foo src', W)).toEqual(PASS);
    expect(run(`rg --hidden foo "${slash(W)}/src"`, W)).toEqual(PASS);
  });

  it('asks from a checkout, or naming a path out of the worktree', () => {
    expect(run('grep -rn TOKEN .')).toEqual(SEARCH);
    expect(run('grep -rn foo ../..', W)).toEqual(SEARCH);
    expect(run(`grep -rn foo "${slash(repo)}"`, W)).toEqual(SEARCH);
    expect(run('rg --hidden foo ~', W)).toEqual(SEARCH);
    expect(run('Get-ChildItem -Recurse | Select-String TOKEN', repo, 'PowerShell')).toEqual(SEARCH);
    expect(run('findstr /s TOKEN *', repo, 'Monitor')).toEqual(SEARCH);
  });

  it("still asks in a teammate's worktree, and asks as before in manual mode", () => {
    expect(run('grep -rn foo .', R)).toEqual(THEIRS);
    expect(run('grep -rn foo .', W, 'Bash', 'default')).toMatchObject({
      kind: 'ask',
      code: 'command.not_listed',
    });
  });
});

describe('auto mode, a call with no cwd', () => {
  it('asks instead of passing', () => {
    for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
      const call = { tool_name: tool, tool_input: { command: 'cat a' }, permission_mode: 'auto' };
      expect(decide(call, ctx)).toMatchObject({ kind: 'ask' });
      expect(decide({ ...call, cwd: 7 }, ctx)).toMatchObject({ kind: 'ask' });
    }
  });
});

describe('the secret deny', () => {
  it('refuses a credential command and says how to reword a false positive', () => {
    expect(run('gh auth token')).toEqual({
      kind: 'deny',
      reason:
        'mesh window: secrets and personal data are never read, printed or sent from here, in any mode; ask your human to do it themselves (if this is a commit message, PR text or search pattern, reword it, or use the Grep tool)',
      code: 'secret.credential',
    });
  });
});
