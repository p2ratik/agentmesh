// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. Where a shell command
// runs, for auto mode's checks: every folder its cd steps reach (relative and `..` targets
// included) and every `.claude/worktrees/mesh-*` it names. A teammate's worktree among them asks;
// a recursive search passes only inside a mesh worktree. A path assembled at run time (a variable,
// a script) isn't seen.
import { resolve } from 'node:path';
import { type Ask, type CommandContext, foreign, isOwn } from './commands';
import { unfold } from './secrets';

/** Pieces split at control operators, quotes kept. */
const PIECES = /&&|\|\||\$\(|[;&|\n\r()`{}]/;
/** A cd step and its target: cd, chdir, pushd, Set-Location or sl, past options and cmd's /d. */
const CD_STEP = /^(?:cd|chdir|pushd|set-location|sl)(?:\s+(?:-{1,2}[\w-]*|\/d))*\s+(.+)$/i;
/** A word: double- or single-quoted text, or a run without spaces or quotes. */
const WORDS = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
const MESH = /\.claude[\\/]worktrees[\\/]mesh-[a-z0-9-]+/i;
/** A word that leaves the folder it is read from: absolute, on a drive, from ~ $ %, or with a
 * `..` segment. A short `/x` word is a findstr or cmd switch, not a path. */
const LEAVES = /^(?!\/[a-z](?::\S*)?$)(?:[~$%\\/]|[A-Za-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/i;

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2');
const pieces = (command: string) => unfold(command).split(PIECES);
const words = (command: string) =>
  [...unfold(command).matchAll(WORDS)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');

/** Every folder the command's cd steps reach, each target resolved against the hook's cwd and
 * against the folder before it. A target from ~, $ or % is left out: it can't be resolved. */
function cdTargets(command: string, cwd: string): string[] {
  const dirs: string[] = [];
  let at = cwd;
  for (const piece of pieces(command)) {
    const target = CD_STEP.exec(piece.trim())?.[1];
    const path = target === undefined ? '' : unquote(target.trim());
    if (path === '' || /^[~$%]/.test(path)) continue;
    at = resolve(at, path);
    dirs.push(resolve(cwd, path), at);
  }
  return dirs;
}

/** Every `.claude/worktrees/mesh-*` the command names, quotes stripped, resolved against the cwd.
 * A quoted word may hold a path with spaces or a whole script (`bash -c "cd …; …"`), so both the
 * word up to the worktree and the part after its last space, `=` or `;` count. */
function meshNamed(command: string, cwd: string): string[] {
  return words(command).flatMap((word) => {
    const hit = MESH.exec(word);
    if (!hit) return [];
    const upTo = word.slice(0, hit.index + hit[0].length);
    const tail = upTo.slice(Math.max(...[' ', '=', ';', '('].map((c) => upTo.lastIndexOf(c))) + 1);
    return [upTo.replace(/^[({`]+/, '').replace(/^[\w-]+=/, ''), tail].map((p) => resolve(cwd, p));
  });
}

/** In auto mode, for a command off the list: it asks when any folder it runs in or names is a
 * mesh worktree whose branch isn't the window's own, since anything run there can run a
 * teammate's code. Null otherwise. */
export function inForeignWorktree(command: string, c: CommandContext): Ask | null {
  const p = c.policy;
  if (!p) return null;
  for (const dir of [c.cwd, ...cdTargets(command, c.cwd), ...meshNamed(command, c.cwd)]) {
    const wt = c.worktreeOf(dir);
    if (wt && !isOwn(wt.branch, p))
      return { ask: foreign(wt.branch), code: 'command.needs_approval' };
  }
  return null;
}

/** In auto mode a recursive search passes only inside a mesh worktree, which never holds the
 * checkout's untracked `.env`: the folders it runs in (the hook's cwd, or only its cd targets
 * when it starts with one) are in one, and every path it names that leaves them resolves into
 * one too. */
export function searchStaysInWorktree(command: string, c: CommandContext): boolean {
  const targets = cdTargets(command, c.cwd);
  const startsWithCd = CD_STEP.test(pieces(command)[0]?.trim() ?? '');
  const dirs = startsWithCd ? targets : [c.cwd, ...targets];
  if (dirs.some((d) => c.worktreeOf(d) === null)) return false;
  return words(command).every((w) => {
    if (!LEAVES.test(w)) return true;
    if (/^[~$%]/.test(w)) return false;
    return dirs.every((d) => c.worktreeOf(resolve(d, w)) !== null);
  });
}
