// Fixtures for the guard's path tests: git's own worktree layout, in a real temp folder.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PathOptions } from './paths';

export const win32 = process.platform === 'win32';
export const folds = win32 || process.platform === 'darwin';

export const NOT_ABSOLUTE = { refused: 'the path is not absolute' };
export const DEVICE = { refused: 'device, UNC and stream paths are refused' };
export const OUTSIDE = { refused: 'not inside .claude/worktrees/mesh-*' };
export const UNREGISTERED = { refused: 'not a registered git worktree' };
export const DOT_GIT = { refused: '.git is off limits' };
export const AGENTMESH = { refused: '~/.agentmesh is off limits' };

export const slash = (p: string) => p.replaceAll('\\', '/');

export function put(file: string, text = ''): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A folder link: a junction on win32 (no privilege needed), a symlink elsewhere. */
export const link = (target: string, at: string) =>
  symlinkSync(target, at, win32 ? 'junction' : 'dir');

export const admin = (repo: string, name: string) => join(repo, '.git', 'worktrees', name);

/** The layout `git worktree add .claude/worktrees/<name> -b <branch>` writes (git 2.49). */
export function mesh(repo: string, name: string, branch: string): string {
  const wt = join(repo, '.claude', 'worktrees', name);
  put(join(admin(repo, name), 'commondir'), '../..\n');
  put(join(admin(repo, name), 'gitdir'), `${slash(join(wt, '.git'))}\n`);
  put(join(admin(repo, name), 'HEAD'), `ref: refs/heads/${branch}\n`);
  put(join(wt, '.git'), `gitdir: ${slash(admin(repo, name))}\n`);
  return wt;
}

/** A temp folder holding a human checkout `repo` (with `src/a.ts`) and an empty home. */
export function fixture(): { base: string; repo: string; o: PathOptions } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'am-guard-')));
  const repo = join(base, 'repo');
  put(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  put(join(repo, 'src', 'a.ts'));
  return { base, repo, o: { platform: process.platform, home: join(base, 'home') } };
}

/** File symlinks need a privilege on win32 (developer mode); tests that need one skip without. */
export const canLinkFiles = (() => {
  const base = mkdtempSync(join(tmpdir(), 'am-guard-probe-'));
  try {
    symlinkSync(join(base, 'target'), join(base, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
})();
