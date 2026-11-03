// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. Which Bash commands the
// mesh window may hand to Claude Code's permission flow (where the launcher's allow rules approve
// routine work); everything else asks the human, which outranks every allow rule. Commands are
// matched whole, against exact forms with no shell metacharacters outside single-quoted messages,
// so a rule's wildcard can never approve extra flags, refspecs or a second command.
import { resolve, sep } from 'node:path';
import { isBranchName, type WindowPolicy } from '@agentmesh/common/window';
import type { MeshWorktree } from './paths';

export interface CommandContext {
  policy: WindowPolicy | null;
  cwd: string;
  worktreeOf: (dir: string) => MeshWorktree | null;
  /** `dir` when it is the top of a real checkout (`checkoutTop` in `./checkout`), else null. */
  checkoutTop: (dir: string) => string | null;
  /** Whether that checkout has fetched `refs/remotes/origin/<branch>` (`./checkout`). */
  remoteRefExists: (top: string, branch: string) => boolean;
  /** Whether nothing is at `<top>/.claude/worktrees/<name>` yet (`./checkout`). */
  freeSlot: (top: string, name: string) => boolean;
}

export type CommandDecision = { pass: true } | { ask: string };

const NO_POLICY =
  "mesh window: ~/.agentmesh/mesh-window.json is missing or invalid, so every command needs your human's approval";
const TEST_OUTSIDE = 'mesh window: run tests inside a task worktree (cd <worktree> && <test>)';
export const UNLISTED =
  "mesh window: this command isn't on the window's list, so your human decides";
const foreign = (branch: string | null) =>
  `mesh window: ${branch ?? 'a detached checkout'} isn't your branch, so running its tests needs your human's approval`;

const ask = (reason: string): CommandDecision => ({ ask: reason });
const pass = (): CommandDecision => ({ pass: true });

/** A path bash and node read alike: no leading dash (`cd -` is OLDPWD, `-P` an option), no
 * leading `//` (a UNC host in Git Bash), and a colon only after a drive letter (`C:t` and `a:b`
 * mean other things on Windows). Plain, or in double quotes with spaces. */
const PATH_RAW = '(?!-|//)(?:[A-Za-z]:(?=/))?[A-Za-z0-9._/-]+';
const PATH_QUOTED = '(?!-|//)(?:[A-Za-z]:(?=/))?[A-Za-z0-9._/ -]+';
const PATH = `(?:${PATH_RAW}|"${PATH_QUOTED}")`;
/** A single-quoted message: printable ASCII without `'` or `\`, so no shell (fish reads `\'`,
 * PowerShell reads curly quotes) ends it early. */
const MESSAGE = String.raw`'[\x20-\x26\x28-\x5b\x5d-\x7e]*'`;
const BRANCH = '([A-Za-z0-9][A-Za-z0-9._/-]*)';
const MESH = String.raw`\.claude/worktrees/(mesh-[a-z0-9][a-z0-9-]{0,62})`;

const EXACT = new Set(['pwd', 'git status', 'git fetch origin', 'git worktree list']);
/** `ls` or `git diff|log|show` and its arguments, each of which must be `safe`. */
const READ = /^(?:ls|git (?:diff|log|show))((?: [A-Za-z0-9._/:@^~=,-]+)*)$/;
const CD = new RegExp(`^cd ${PATH}$`);
// `origin/<b>` resolves to a fetched tag of that name first: --track refuses a tag, and the full
// spelling names the remote branch whenever it exists.
const WORKTREE_OWN = new RegExp(`^git worktree add ${MESH} -b ${BRANCH} --track origin/${BRANCH}$`);
const WORKTREE_REVIEW = new RegExp(`^git worktree add ${MESH} refs/remotes/origin/${BRANCH}$`);
const WORKTREE_REMOVE = new RegExp(`^git worktree remove ${MESH}$`);
const CD_AND = new RegExp(`^cd (?:(${PATH_RAW})|"(${PATH_QUOTED})") && (.+)$`);
const ADD = new RegExp(`^git add (?:-A|--(?: ${PATH})+)$`);
const COMMIT = new RegExp(`^git commit(?: -m ${MESSAGE})+$`);
const PUSH = new RegExp(`^git push (?:-u )?origin ${BRANCH}$`);
const PR = new RegExp(
  `^gh pr create --base ${BRANCH} --head ${BRANCH}(?: --title ${MESSAGE})?(?: --body ${MESSAGE})?$`,
);

/** A read's argument that stays in the tree: not absolute, home-relative or on a drive (git diffs
 * a path outside the tree as --no-index and prints it), no `..` segment, no `//` (a UNC host on
 * Windows, even as an option's value), and never `--no-index` or `--output` (git takes no
 * abbreviation of either). */
function safe(arg: string): boolean {
  if (/^(?:--output|--no-index|\/|~|[A-Za-z]:)/.test(arg)) return false;
  return !arg.includes('//') && !arg.split('/').includes('..');
}

/** `ls`, or a git read. A git read with arguments passes only inside a checkout or a worktree:
 * outside a repo `git diff a b` runs as --no-index, and follows links out of the tree. */
function reads(command: string, c: CommandContext): boolean {
  const m = READ.exec(command);
  if (m === null) return false;
  const args = (m[1] ?? '').split(' ').slice(1);
  if (!args.every(safe)) return false;
  if (args.length === 0 || !command.startsWith('git ')) return true;
  return c.worktreeOf(c.cwd) !== null || c.checkoutTop(c.cwd) !== null;
}

/** `-b <branch> --track origin/<start>`: a new own branch from the integration branch. */
function ownStart(branch: string, start: string | undefined, p: WindowPolicy): boolean {
  const prefix = p.ownBranchPrefix;
  return (
    prefix !== null &&
    branch.length > prefix.length &&
    branch.startsWith(prefix) &&
    isBranchName(branch) &&
    start === p.integrationBranch
  );
}

/** `git worktree add|remove` of a mesh worktree, run from the top of a real checkout: never from a
 * folder a branch could have committed, with `.claude/worktrees` as a link git would write through.
 * An add needs its slot empty. A review worktree checks out a remote branch the checkout has
 * fetched; a task worktree starts an own branch from the integration branch. */
function worktreeChange(command: string, c: CommandContext, p: WindowPolicy): boolean | null {
  const own = WORKTREE_OWN.exec(command);
  const review = WORKTREE_REVIEW.exec(command);
  if (!own && !review && !WORKTREE_REMOVE.test(command)) return null;
  const top = c.checkoutTop(c.cwd);
  if (top === null) return false;
  const add = own ?? review;
  if (!add) return true;
  if (!c.freeSlot(top, add[1] ?? '')) return false;
  if (review) {
    const branch = review[2] ?? '';
    return isBranchName(branch) && c.remoteRefExists(top, branch);
  }
  return own !== null && ownStart(own[2] ?? '', own[3], p);
}

/** A cd target bash never looks up in CDPATH: absolute in this platform's spelling (`/…`, or
 * `X:/…` on Windows, where a leading `/` is Git Bash's own root, not this drive's) or `./…`. */
const anchored = (path: string) =>
  path.startsWith('./') || (sep === '\\' ? /^[A-Za-z]:\//.test(path) : path.startsWith('/'));

/** The folder a command runs in and the command itself: `cd PATH && rest`, or `cwd`. Null for an
 * unanchored PATH, a `..` segment (node folds it as text, bash after following a link) or a rest
 * that is another cd. */
function placed(command: string, cwd: string): { dir: string; rest: string } | null {
  const m = CD_AND.exec(command);
  if (!m) return { dir: cwd, rest: command };
  const path = m[1] ?? m[2] ?? '';
  const rest = m[3] ?? '';
  if (!anchored(path) || path.split('/').includes('..') || rest.startsWith('cd ')) return null;
  return { dir: resolve(cwd, path), rest };
}

/** A delivery form for this worktree's own `branch`: stage, commit, push it, open its PR. */
function delivers(rest: string, branch: string, p: WindowPolicy): boolean {
  if (ADD.test(rest) || COMMIT.test(rest)) return true;
  const push = PUSH.exec(rest);
  if (push) return push[1] === branch;
  const pr = PR.exec(rest);
  return pr !== null && pr[1] === p.integrationBranch && pr[2] === branch;
}

const isDelivery = (rest: string) => [ADD, COMMIT, PUSH, PR].some((r) => r.test(rest));

/** A test or delivery command: it passes only in a mesh worktree on the window's own branch. Test
 * commands are compared by string equality, never by pattern. */
function inWorktree(command: string, c: CommandContext, p: WindowPolicy): CommandDecision {
  const test = p.testCommands.includes(command);
  if (!test && !isDelivery(command)) return ask(UNLISTED);
  const wt = c.worktreeOf(c.cwd);
  const branch = wt?.branch ?? null;
  const prefix = p.ownBranchPrefix;
  const own = branch !== null && prefix !== null && branch.startsWith(prefix);
  if (test) return own ? pass() : ask(wt ? foreign(branch) : TEST_OUTSIDE);
  return own && delivers(command, branch, p) ? pass() : ask(UNLISTED);
}

/** A listed command, run in `c.cwd`. */
function listed(command: string, c: CommandContext, p: WindowPolicy): CommandDecision {
  if (EXACT.has(command) || reads(command, c)) return pass();
  const change = worktreeChange(command, c, p);
  if (change !== null) return change ? pass() : ask(UNLISTED);
  return inWorktree(command, c, p);
}

/** Whether `command` may go on to Claude Code's permission flow, or must ask the human. A listed
 * command may follow `cd PATH && `, and is classified as if it ran in PATH. */
export function classifyCommand(command: string, c: CommandContext): CommandDecision {
  const p = c.policy;
  if (!p) return ask(NO_POLICY);
  if (typeof command !== 'string' || typeof c.cwd !== 'string') return ask(UNLISTED);
  if (CD.test(command)) return pass();
  const at = placed(command, c.cwd);
  return at === null ? ask(UNLISTED) : listed(at.rest, { ...c, cwd: at.dir }, p);
}
