// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. It reads git's files
// directly and never spawns git. Nothing throws: anything odd or unreadable is a "no".
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isBranchName } from '@agentmesh/common/window';
import { badInput, key, type PathOptions } from './paths';

const lib = (o: PathOptions) => (o.platform === 'win32' ? path.win32 : path.posix);

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** What lstat finds there: a real folder, nothing, or anything else (a link or a Windows junction,
 * a file, an error). */
function kind(file: string): 'dir' | 'missing' | 'other' {
  try {
    return lstatSync(file).isDirectory() ? 'dir' : 'other';
  } catch (error) {
    return code(error) === 'ENOENT' ? 'missing' : 'other';
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

/** Whether nothing at all is at `<top>/.claude/worktrees/<name>` (a mesh slug): git worktree add
 * writes through a link already there, even one to an empty folder. */
export function freeSlot(top: string, name: string, o: PathOptions): boolean {
  return kind(lib(o).join(top, '.claude', 'worktrees', name)) === 'missing';
}

const OID = '[0-9a-f]{40}(?:[0-9a-f]{24})?';
const LOOSE = new RegExp(`^(?:${OID}|ref: refs/\\S+)\\r?\\n?$`);
const PACKED = new RegExp(`^${OID} (.+)$`);

/** A ref name segment git accepts. */
const plain = (s: string) =>
  s !== '' && !s.startsWith('.') && !s.endsWith('.') && !s.endsWith('.lock');

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The loose ref for `segments` under `<git>/refs/remotes/origin`, each segment matched by its exact
 * name on disk. 'refused' when only a name the file system folds to the same one is there (a case
 * twin: git would open that other branch's ref for it), or a folder can't be read. */
function looseRef(git: string, segments: string[], o: PathOptions): string | 'missing' | 'refused' {
  const p = lib(o);
  let at = p.join(git, 'refs', 'remotes', 'origin');
  for (const s of segments) {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch (error) {
      return code(error) === 'ENOENT' || code(error) === 'ENOTDIR' ? 'missing' : 'refused';
    }
    if (!names.includes(s)) {
      const fold = (n: string) => key(n, o).toUpperCase();
      return names.some((n) => fold(n) === fold(s)) ? 'refused' : 'missing';
    }
    at = p.join(at, s);
  }
  return at;
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
  const loose = looseRef(git, segments, o);
  if (loose === 'refused') return false;
  if (loose !== 'missing') {
    try {
      return lstatSync(loose).isFile() && LOOSE.test(read(loose) ?? '');
    } catch {
      return false;
    }
  }
  const name = `refs/remotes/origin/${branch}`;
  const lines = read(p.join(git, 'packed-refs'))?.split(/\r?\n/) ?? [];
  return lines.some((line) => PACKED.exec(line)?.[1] === name);
}
