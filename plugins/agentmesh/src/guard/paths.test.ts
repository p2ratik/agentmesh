import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editTarget, meshWorktreeOf, type PathOptions } from './paths';

const win32 = process.platform === 'win32';
const folds = win32 || process.platform === 'darwin';
const NOT_ABSOLUTE = { refused: 'the path is not absolute' };
const DEVICE = { refused: 'device, UNC and stream paths are refused' };
const OUTSIDE = { refused: 'not inside .claude/worktrees/mesh-*' };
const UNREGISTERED = { refused: 'not a registered git worktree' };
const DOT_GIT = { refused: '.git is off limits' };
const AGENTMESH = { refused: '~/.agentmesh is off limits' };

let base: string;
let repo: string;
let o: PathOptions;

const slash = (p: string) => p.replaceAll('\\', '/');
const put = (file: string, text = '') => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const link = (target: string, at: string) => symlinkSync(target, at, win32 ? 'junction' : 'dir');
const admin = (name: string, at = repo) => join(at, '.git', 'worktrees', name);

/** The layout `git worktree add .claude/worktrees/<name> -b <branch>` writes (git 2.49). */
function mesh(at: string, name: string, branch: string): string {
  const wt = join(at, '.claude', 'worktrees', name);
  put(join(admin(name, at), 'commondir'), '../..\n');
  put(join(admin(name, at), 'gitdir'), `${slash(join(wt, '.git'))}\n`);
  put(join(admin(name, at), 'HEAD'), `ref: refs/heads/${branch}\n`);
  put(join(wt, '.git'), `gitdir: ${slash(admin(name, at))}\n`);
  return wt;
}

/** Both checks refuse `path` with `refusal`. */
function refusedBoth(path: string, refusal: { refused: string }) {
  expect(meshWorktreeOf(path, o)).toEqual(refusal);
  expect(editTarget(path, o)).toEqual(refusal);
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'am-guard-')));
  repo = join(base, 'repo');
  put(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  put(join(repo, 'src', 'a.ts'));
  o = { platform: process.platform, home: join(base, 'home') };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('accepts', () => {
  it('accepts a file inside a registered mesh worktree', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    put(join(wt, 'a.ts'));
    const worktree = { root: wt, gitDir: admin('mesh-a'), branch: 'agent/pratik/task-1-a' };
    expect(meshWorktreeOf(join(wt, 'a.ts'), o)).toEqual(worktree);
    expect(meshWorktreeOf(wt, o)).toEqual(worktree);
    expect(editTarget(join(wt, 'a.ts'), o)).toEqual({ ok: true });
    expect(meshWorktreeOf(join(wt, 'new', 'dir', 'b.ts'), o)).toEqual(worktree);
    expect(editTarget(join(wt, 'new', 'dir', 'b.ts'), o)).toEqual({ ok: true });
    expect(editTarget(join(wt, '.gitignore'), o)).toEqual({ ok: true });

    const detached = mesh(repo, 'mesh-b', 'unused');
    put(join(admin('mesh-b'), 'HEAD'), 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3\n');
    expect(meshWorktreeOf(join(detached, 'a.ts'), o)).toMatchObject({ branch: null });
  });

  it('accepts the relative pointers of worktree.useRelativePaths', () => {
    const wt = mesh(repo, 'mesh-r', 'r1');
    put(join(wt, '.git'), 'gitdir: ../../../.git/worktrees/mesh-r\r\n');
    put(join(admin('mesh-r'), 'gitdir'), '../../../.claude/worktrees/mesh-r/.git\n');
    expect(meshWorktreeOf(join(wt, 'a.ts'), o)).toEqual({
      root: wt,
      gitDir: admin('mesh-r'),
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
    put(join(fake, '.git'), `gitdir: ${slash(admin('mesh-a'))}\n`);
    refusedBoth(join(fake, 'a.ts'), UNREGISTERED);
  });

  it('refuses a worktree whose git files are missing or malformed', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    unlinkSync(join(admin('mesh-a'), 'commondir'));
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
    put(join(admin('mesh-a'), 'commondir'), '../..\n');
    unlinkSync(join(admin('mesh-a'), 'gitdir'));
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
    put(join(wt, '.git'), `gitdir: ${slash(join(repo, '.git', 'worktrees', 'gone'))}\n`);
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
    put(join(wt, '.git'), `${slash(admin('mesh-a'))}\n`);
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
  });

  it('refuses a symlink or junction out of the worktree', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    link(join(repo, 'src'), join(wt, 'out'));
    refusedBoth(join(wt, 'out', 'a.ts'), OUTSIDE);
    refusedBoth(join(wt, 'out', 'new', 'b.ts'), OUTSIDE);
    link(join(repo, 'src', 'missing'), join(wt, 'dangling'));
    refusedBoth(join(wt, 'dangling', 'b.ts'), OUTSIDE);
    const fake = join(base, 'fake', '.claude');
    mkdirSync(fake, { recursive: true });
    link(join(repo, 'src'), join(fake, 'worktrees'));
    refusedBoth(join(fake, 'worktrees', 'mesh-a', 'a.ts'), OUTSIDE);
  });

  it('refuses .. out of the worktree', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    const sep = win32 ? '\\' : '/';
    refusedBoth([wt, '..', '..', '..', 'src', 'a.ts'].join(sep), OUTSIDE);
    refusedBoth([wt, '..', 'x.ts'].join(sep), OUTSIDE);
    refusedBoth(`${slash(wt)}/missing/../../../../src/a.ts`, OUTSIDE);
    link(join(repo, 'src'), join(wt, 'out'));
    // POSIX follows the link before `..`; Win32 folds `..` as text, so it stays in the worktree.
    const via = `${slash(wt)}/out/../x.ts`;
    if (win32) expect(editTarget(via, o)).toEqual({ ok: true });
    else refusedBoth(via, OUTSIDE);
  });

  it('refuses .git inside a worktree', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    expect(meshWorktreeOf(join(wt, '.git'), o)).toMatchObject({ root: wt });
    expect(editTarget(join(wt, '.git'), o)).toEqual(DOT_GIT);
    expect(editTarget(join(wt, 'sub', '.git', 'hooks', 'pre-commit'), o)).toEqual(DOT_GIT);
    if (folds) expect(editTarget(join(wt, 'sub', '.GIT', 'config'), o)).toEqual(DOT_GIT);
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

  it.runIf(win32)('refuses device, UNC and stream paths', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    for (const path of [
      '\\\\?\\C:\\x\\a.ts',
      `\\\\?\\${join(wt, 'a.ts')}`,
      '\\\\.\\pipe\\x',
      '\\\\server\\share\\a.ts',
      '//?/C:/x/a.ts',
      '//./pipe/x',
      '//server/share/a.ts',
      '\\??\\C:\\x\\a.ts',
      'C:\\r\\a.ts:evil',
      `${join(wt, 'a.ts')}::$DATA`,
    ]) {
      refusedBoth(path, DEVICE);
    }
  });

  it.runIf(win32)(
    'refuses a segment ending in a dot or space (Win32 drops them, Node does not)',
    () => {
      const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
      mkdirSync(join(wt, 'sub', '.git'), { recursive: true });
      link(join(repo, 'src'), join(wt, 'out'));
      for (const path of [
        `${wt}\\out.\\a.ts`,
        `${wt}\\out \\a.ts`,
        `${wt}\\sub\\.git. \\config`,
        `${wt}\\sub\\.git.\\hooks\\pre-commit`,
        `${wt}\\a.ts.`,
        `${wt}\\.../a.ts`,
      ]) {
        refusedBoth(path, DEVICE);
      }
    },
  );

  it('refuses a relative path', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    for (const path of ['src/a.ts', './a.ts', '', `${join(wt, 'a')}\0.ts`]) {
      refusedBoth(path, NOT_ABSOLUTE);
    }
    if (win32)
      for (const path of ['C:a.ts', '\\r\\a.ts', '/r/a.ts']) refusedBoth(path, NOT_ABSOLUTE);
  });
});
