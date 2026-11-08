import { mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editTarget, meshWorktreeOf, type PathOptions } from './paths';
import {
  AGENTMESH,
  admin,
  DOT_GIT,
  fixture,
  folds,
  link,
  mesh,
  NOT_ABSOLUTE,
  OUTSIDE,
  put,
  slash,
  UNREGISTERED,
  UNRESOLVED,
  win32,
} from './paths.fixture';

let base: string;
let repo: string;
let o: PathOptions;

/** Both checks refuse `path` with `refusal`. */
function refusedBoth(path: string, refusal: { refused: string }) {
  expect(meshWorktreeOf(path, o)).toEqual(refusal);
  expect(editTarget(path, o)).toEqual(refusal);
}

beforeEach(() => {
  ({ base, repo, o } = fixture());
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('accepts', () => {
  it('accepts a file inside a registered mesh worktree', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    put(join(wt, 'a.ts'));
    const worktree = { root: wt, gitDir: admin(repo, 'mesh-a'), branch: 'agent/pratik/task-1-a' };
    expect(meshWorktreeOf(join(wt, 'a.ts'), o)).toEqual(worktree);
    expect(meshWorktreeOf(wt, o)).toEqual(worktree);
    expect(editTarget(join(wt, 'a.ts'), o)).toEqual({ ok: true });
    expect(meshWorktreeOf(join(wt, 'new', 'dir', 'b.ts'), o)).toEqual(worktree);
    expect(editTarget(join(wt, 'new', 'dir', 'b.ts'), o)).toEqual({ ok: true });
    expect(editTarget(join(wt, '.gitignore'), o)).toEqual({ ok: true });

    const detached = mesh(repo, 'mesh-b', 'unused');
    put(join(admin(repo, 'mesh-b'), 'HEAD'), 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3\n');
    expect(meshWorktreeOf(join(detached, 'a.ts'), o)).toMatchObject({ branch: null });
  });

  it('accepts the relative pointers of worktree.useRelativePaths', () => {
    const wt = mesh(repo, 'mesh-r', 'r1');
    put(join(wt, '.git'), 'gitdir: ../../../.git/worktrees/mesh-r\r\n');
    put(join(admin(repo, 'mesh-r'), 'gitdir'), '../../../.claude/worktrees/mesh-r/.git\n');
    expect(meshWorktreeOf(join(wt, 'a.ts'), o)).toEqual({
      root: wt,
      gitDir: admin(repo, 'mesh-r'),
      branch: 'r1',
    });
  });

  it.runIf(win32)('accepts the same path with a lowercase drive and forward slashes', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    put(join(wt, 'a.ts'));
    const spell = (p: string) =>
      slash(p)
        .replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        .replace('/.claude/worktrees/mesh-a', '/.Claude/WORKTREES/Mesh-A');
    expect(meshWorktreeOf(spell(join(wt, 'a.ts')), o)).toMatchObject({ root: wt });
    expect(editTarget(spell(join(wt, 'a.ts')), o)).toEqual({ ok: true });
    expect(editTarget(spell(join(wt, 'New', 'b.ts')), o)).toEqual({ ok: true });
  });

  it('accepts a checkout path with spaces', () => {
    const web = join(base, 'Users', 'John Smith', 'opzami', 'web');
    put(join(web, '.git', 'HEAD'));
    const wt = mesh(web, 'mesh-task-2-fix', 'agent/john/task-2-fix');
    expect(meshWorktreeOf(join(wt, 'src', 'a b.ts'), o)).toMatchObject({ root: wt });
    expect(editTarget(join(wt, 'src', 'a b.ts'), o)).toEqual({ ok: true });
  });
});

describe('refuses', () => {
  it('refuses the human checkout', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    expect(editTarget(wt, o)).toEqual(OUTSIDE);
    refusedBoth(join(repo, 'src', 'a.ts'), OUTSIDE);
    refusedBoth(join(repo, 'src', 'new.ts'), OUTSIDE);
    refusedBoth(join(repo, '.git', 'hooks', 'pre-commit'), OUTSIDE);
    refusedBoth(join(repo, '.claude', 'worktrees', 'x.ts'), OUTSIDE);
  });

  it('refuses a worktree without the mesh- prefix', () => {
    const wt = mesh(repo, 'feature', 'feature');
    refusedBoth(join(wt, 'a.ts'), OUTSIDE);
  });

  it('refuses a fake .claude/worktrees folder', () => {
    mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    const fake = join(repo, 'src', '.claude', 'worktrees', 'mesh-x');
    put(join(fake, 'a.ts'));
    refusedBoth(join(fake, 'a.ts'), UNREGISTERED);
    mkdirSync(join(fake, '.git'));
    refusedBoth(join(fake, 'a.ts'), UNREGISTERED);
    refusedBoth(join(repo, 'src', '.claude', 'worktrees', 'mesh-new', 'a.ts'), UNREGISTERED);
  });

  it('refuses a .git file whose back-pointer names another folder', () => {
    mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    const fake = join(repo, 'src', '.claude', 'worktrees', 'mesh-a');
    put(join(fake, '.git'), `gitdir: ${slash(admin(repo, 'mesh-a'))}\n`);
    refusedBoth(join(fake, 'a.ts'), UNREGISTERED);
  });

  it('refuses a worktree whose git files are missing or malformed', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    unlinkSync(join(admin(repo, 'mesh-a'), 'commondir'));
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
    put(join(admin(repo, 'mesh-a'), 'commondir'), '../..\n');
    unlinkSync(join(admin(repo, 'mesh-a'), 'gitdir'));
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
    put(join(wt, '.git'), `gitdir: ${slash(join(repo, '.git', 'worktrees', 'gone'))}\n`);
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
    put(join(wt, '.git'), `${slash(admin(repo, 'mesh-a'))}\n`);
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
  });

  it('refuses a symlink or junction out of the worktree', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    link(join(repo, 'src'), join(wt, 'out'));
    refusedBoth(join(wt, 'out', 'a.ts'), OUTSIDE);
    refusedBoth(join(wt, 'out', 'new', 'b.ts'), OUTSIDE);
    link(join(repo, 'src', 'missing'), join(wt, 'dangling'));
    refusedBoth(join(wt, 'dangling', 'b.ts'), UNRESOLVED);
    const fake = join(base, 'fake', '.claude');
    mkdirSync(fake, { recursive: true });
    link(join(repo, 'src'), join(fake, 'worktrees'));
    refusedBoth(join(fake, 'worktrees', 'mesh-a', 'a.ts'), OUTSIDE);
  });

  it('refuses .git inside a worktree', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    expect(meshWorktreeOf(join(wt, '.git'), o)).toMatchObject({ root: wt });
    expect(editTarget(join(wt, '.git'), o)).toEqual(DOT_GIT);
    expect(editTarget(join(wt, 'sub', '.git', 'hooks', 'pre-commit'), o)).toEqual(DOT_GIT);
    expect(editTarget(join(wt, 'sub', '.GIT', 'config'), o)).toEqual(DOT_GIT);
  });

  it('refuses ~/.agentmesh', () => {
    put(join(o.home, '.agentmesh', 'agent.json'));
    expect(meshWorktreeOf(join(o.home, '.agentmesh', 'agent.json'), o)).toEqual(OUTSIDE);
    expect(editTarget(join(o.home, '.agentmesh', 'agent.json'), o)).toEqual(AGENTMESH);
    expect(editTarget(join(o.home, '.agentmesh', 'new.json'), o)).toEqual(AGENTMESH);
    if (folds) expect(editTarget(join(o.home, '.AgentMesh', 'x'), o)).toEqual(AGENTMESH);

    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    const home = join(base, 'linked-home');
    mkdirSync(join(wt, 'state'), { recursive: true });
    mkdirSync(home);
    link(join(wt, 'state'), join(home, '.agentmesh'));
    expect(editTarget(join(wt, 'state', 'agent.json'), { ...o, home })).toEqual(AGENTMESH);
    expect(editTarget(join(wt, 'other.json'), { ...o, home })).toEqual({ ok: true });
    expect(editTarget(join(wt, 'other.json'), { ...o, home: '' })).toEqual(AGENTMESH);
  });

  it('refuses a relative path', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    for (const path of ['src/a.ts', './a.ts', '', `${join(wt, 'a')}\0.ts`]) {
      refusedBoth(path, NOT_ABSOLUTE);
    }
    if (win32) {
      for (const path of ['C:a.ts', '\\r\\a.ts', '/r/a.ts']) refusedBoth(path, NOT_ABSOLUTE);
    }
  });
});
