// Fixtures for the guard's path tests: git's own worktree layout, in a real temp folder.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PathOptions } from './paths';

export const win32 = process.platform === 'win32';
export const folds = win32 || process.platform === 'darwin';

// Each refusal's text (what Claude sees) and its code (what the timeline records).
const OUTSIDE_TEXT = 'not inside .claude/worktrees/mesh-*';
export const NOT_ABSOLUTE = { refused: 'the path is not absolute', code: 'path.not_absolute' };
export const DEVICE = { refused: 'device, UNC and stream paths are refused', code: 'path.device' };
export const OUTSIDE = { refused: OUTSIDE_TEXT, code: 'path.outside_worktree' };
/** Something is there but won't resolve: a dangling link, a loop, a file used as a folder. */
export const UNRESOLVED = { refused: OUTSIDE_TEXT, code: 'path.unresolved' };
/** The write would reach past the path: its last segment is a link, or a hard-linked file. */
export const LINK = { refused: OUTSIDE_TEXT, code: 'path.link' };
export const UNREGISTERED = {
  refused: 'not a registered git worktree',
  code: 'path.not_registered_worktree',
};
export const DOT_GIT = { refused: '.git is off limits', code: 'path.git_dir' };
export const AGENTMESH = { refused: '~/.agentmesh is off limits', code: 'path.agentmesh_dir' };

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
