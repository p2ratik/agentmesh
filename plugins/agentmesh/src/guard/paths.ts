// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. It reads git's files
// directly and never spawns git. Nothing throws: a git file that is missing or wrong is a refusal.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface PathOptions {
  platform: NodeJS.Platform;
  home: string;
}

export interface MeshWorktree {
  root: string;
  gitDir: string;
  branch: string | null;
}

type Refusal = { refused: string };

const NOT_ABSOLUTE = { refused: 'the path is not absolute' };
const DEVICE = { refused: 'device, UNC and stream paths are refused' };
const OUTSIDE = { refused: 'not inside .claude/worktrees/mesh-*' };
const UNREGISTERED = { refused: 'not a registered git worktree' };
const DOT_GIT = { refused: '.git is off limits' };
const AGENTMESH = { refused: '~/.agentmesh is off limits' };

const lib = (o: PathOptions) => (o.platform === 'win32' ? path.win32 : path.posix);

function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** What the file system treats as the same name: case folded on win32 and darwin (to upper case,
 * as NTFS does). HFS+ also ignores invisible format characters (git's protectHFS). */
function key(segment: string, o: PathOptions): string {
  if (o.platform === 'win32') return segment.toUpperCase();
  if (o.platform === 'darwin') {
    const visible = segment.normalize('NFC').replace(/\p{Cf}/gu, '');
    return visible.toUpperCase();
  }
  return segment;
}

function split(file: string, o: PathOptions): { top: string; segments: string[] } {
  const p = lib(o);
  const top = p.parse(file).root;
  return { top, segments: file.slice(top.length).split(p.sep).filter(Boolean) };
}

const keys = (file: string, o: PathOptions) => {
  const { top, segments } = split(file, o);
  return [key(top, o), ...segments.map((s) => key(s, o))];
};

/** `inner` is `outer` or below it. */
function within(inner: string, outer: string, o: PathOptions): boolean {
  const a = keys(inner, o);
  const b = keys(outer, o);
  return b.length <= a.length && b.every((k, i) => k === a[i]);
}

/** Why a path is refused before the disk is touched (no UNC host is ever contacted), or null. */
function badInput(file: string, o: PathOptions): Refusal | null {
  if (file.includes('\0')) return NOT_ABSOLUTE;
  if (o.platform !== 'win32') return path.posix.isAbsolute(file) ? null : NOT_ABSOLUTE;
  if (/^[\\/]([\\/]|\?\?[\\/])/.test(file)) return DEVICE;
  if (!/^[a-z]:[\\/]/i.test(file)) return NOT_ABSOLUTE;
  // Win32 drops a segment's trailing dots and spaces (`out.` opens the link `out`); Node doesn't.
  return file.includes(':', 2) || /[. ](\\|$)/.test(path.win32.resolve(file)) ? DEVICE : null;
}

/** The real path, or the path itself when nothing is there yet; null when something is there but
 * won't resolve (a dangling link, a loop, a file used as a folder). */
function realOrMissing(file: string): string | null {
  const real = attempt(() => realpathSync.native(file));
  if (real !== undefined) return real;
  try {
    lstatSync(file);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? file : null;
  }
}

/** Where a write to `file` lands: links followed segment by segment, a missing tail kept. Win32
 * folds `..` as text before following links; POSIX kernels follow a link before its `..`. */
function resolve(file: string, o: PathOptions): string | null {
  const p = lib(o);
  const full = o.platform === 'win32' ? p.resolve(file) : file;
  const { top, segments } = split(full, o);
  let current = top;
  for (const segment of segments) {
    if (segment === '.') continue;
    const next = realOrMissing(segment === '..' ? p.dirname(current) : p.join(current, segment));
    if (next === null) return null;
    current = next;
  }
  return current;
}

/** The real path of an existing file that git wrote, refusing device and UNC spellings in it. */
function realFile(file: string, o: PathOptions): string | undefined {
  return badInput(file, o) ? undefined : attempt(() => realpathSync.native(file));
}

const readLine = (file: string) =>
  attempt(() => readFileSync(file, 'utf8'))?.replace(/[\r\n]+$/, '');

/** Steps 3 to 7: the registered mesh worktree holding `resolved`, and the key segments below it. */
function registered(
  resolved: string,
  o: PathOptions,
): { worktree: MeshWorktree; below: string[] } | Refusal {
  const p = lib(o);
  const { top, segments } = split(resolved, o);
  const k = segments.map((s) => key(s, o));
  let i = k.length - 3;
  while (i >= 0 && !(k[i] === key('.claude', o) && k[i + 1] === key('worktrees', o))) i--;
  if (i < 0 || !k[i + 2]?.startsWith(key('mesh-', o))) return OUTSIDE;

  const root = p.join(top, ...segments.slice(0, i + 3));
  const dotGit = p.join(root, '.git');
  if (!attempt(() => lstatSync(dotGit))?.isFile()) return UNREGISTERED;
  const pointer = /^gitdir: (.+)$/.exec(readLine(dotGit) ?? '')?.[1];
  const gitDir = pointer === undefined ? undefined : realFile(p.resolve(root, pointer), o);
  if (gitDir === undefined || !attempt(() => lstatSync(p.join(gitDir, 'commondir')))) {
    return UNREGISTERED;
  }
  const back = readLine(p.join(gitDir, 'gitdir'));
  const backReal = back ? realFile(p.resolve(gitDir, back), o) : undefined;
  const dotGitReal = realFile(dotGit, o);
  if (!backReal || !dotGitReal || keys(backReal, o).join('/') !== keys(dotGitReal, o).join('/')) {
    return UNREGISTERED;
  }
  const head = readLine(p.join(gitDir, 'HEAD')) ?? '';
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  return { worktree: { root, gitDir, branch }, below: k.slice(i + 3) };
}

function located(file: string, o: PathOptions): string | Refusal {
  const bad = badInput(file, o);
  if (bad) return bad;
  return resolve(file, o) ?? OUTSIDE;
}

/** The registered mesh worktree that contains `file` (or is it), resolved through links. */
export function meshWorktreeOf(file: string, o: PathOptions): MeshWorktree | Refusal {
  const resolved = located(file, o);
  if (typeof resolved !== 'string') return resolved;
  const found = registered(resolved, o);
  return 'refused' in found ? found : found.worktree;
}

/** Whether the mesh window may write `file`: strictly inside a registered mesh worktree, never a
 * `.git` path below its root, never inside the real `~/.agentmesh`. */
export function editTarget(file: string, o: PathOptions): { ok: true } | Refusal {
  const resolved = located(file, o);
  if (typeof resolved !== 'string') return resolved;
  const p = lib(o);
  const agentmesh = p.isAbsolute(o.home) ? resolve(p.join(o.home, '.agentmesh'), o) : null;
  if (agentmesh === null || within(resolved, agentmesh, o)) return AGENTMESH;
  const found = registered(resolved, o);
  if ('refused' in found) return found;
  if (found.below.length === 0) return OUTSIDE;
  return found.below.includes(key('.git', o)) ? DOT_GIT : { ok: true };
}
