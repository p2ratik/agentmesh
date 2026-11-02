// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. It reads git's files
// directly and never spawns git. Nothing throws: anything odd or unreadable is a "no".
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isBranchName } from '@agentmesh/common/window';
import { badInput, DOS_DEVICE, type PathOptions } from './paths';

const lib = (o: PathOptions) => (o.platform === 'win32' ? path.win32 : path.posix);

/** What lstat finds there: a real folder, nothing, or anything else (a link or a Windows junction,
 * a file, an error). */
function kind(file: string): 'dir' | 'missing' | 'other' {
  try {
    return lstatSync(file).isDirectory() ? 'dir' : 'other';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

/** `dir` when it is the top of a real checkout: its `.git` a real folder (a branch can't commit
 * one), and its `.claude` and `.claude/worktrees`, where they exist, real folders too (a branch
 * can commit those as links, and `git worktree add` would write through them). */
export function checkoutTop(dir: string, o: PathOptions): string | null {
  if (badInput(dir, o)) return null;
  const p = lib(o);
  if (kind(p.join(dir, '.git')) !== 'dir') return null;
  const claude = kind(p.join(dir, '.claude'));
  if (claude === 'other') return null;
  if (claude === 'dir' && kind(p.join(dir, '.claude', 'worktrees')) === 'other') return null;
  return dir;
}

const OID = '[0-9a-f]{40}(?:[0-9a-f]{24})?';
const LOOSE = new RegExp(`^(?:${OID}|ref: refs/\\S+)\\r?\\n?$`);
const PACKED = new RegExp(`^${OID} (.+)$`);

/** A ref name segment git accepts and every file system stores as itself. */
const plain = (s: string) =>
  s !== '' && !s.startsWith('.') && !s.endsWith('.') && !s.endsWith('.lock') && !DOS_DEVICE.test(s);

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Whether the checkout at `top` has `refs/remotes/origin/<branch>`, as a loose ref file or a
 * packed-refs line. Then git resolves that spelling to it, not to a fetched tag of the same name.
 * False on reftable, which this doesn't read. */
export function remoteRefExists(top: string, branch: string, o: PathOptions): boolean {
  if (typeof branch !== 'string' || !isBranchName(branch)) return false;
  const segments = branch.split('/');
  if (!segments.every(plain)) return false;
  const p = lib(o);
  const git = p.join(top, '.git');
  if (kind(p.join(git, 'reftable')) !== 'missing') return false;
  const loose = p.join(git, 'refs', 'remotes', 'origin', ...segments);
  try {
    if (!lstatSync(loose).isFile()) return false;
    return LOOSE.test(read(loose) ?? '');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
  }
  const name = `refs/remotes/origin/${branch}`;
  const lines = read(p.join(git, 'packed-refs'))?.split(/\r?\n/) ?? [];
  return lines.some((line) => PACKED.exec(line)?.[1] === name);
}
