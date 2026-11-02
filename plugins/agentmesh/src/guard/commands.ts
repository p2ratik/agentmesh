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
}

export type CommandDecision = { pass: true } | { ask: string };

const NO_POLICY =
  "mesh window: ~/.agentmesh/mesh-window.json is missing or invalid, so every command needs your human's approval";
const TEST_OUTSIDE = 'mesh window: run tests inside a task worktree (cd <worktree> && <test>)';
const UNLISTED = "mesh window: this command isn't on the window's list, so your human decides";
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
const MESH = String.raw`\.claude/worktrees/mesh-[a-z0-9][a-z0-9-]{0,62}`;

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

function reads(command: string): boolean {
  const m = READ.exec(command);
  return m !== null && (m[1] ?? '').split(' ').slice(1).every(safe);
}

/** `git worktree add|remove` of a mesh worktree, run from the top of a real checkout: never from a
 * folder a branch could have committed, with `.claude/worktrees` as a link git would write through.
 * A review worktree checks out a remote branch the checkout has fetched; a task worktree starts an
 * own branch from the integration branch. */
function worktreeChange(command: string, c: CommandContext, p: WindowPolicy): boolean | null {
  const own = WORKTREE_OWN.exec(command);
  const review = WORKTREE_REVIEW.exec(command);
  if (!own && !review && !WORKTREE_REMOVE.test(command)) return null;
  const top = c.checkoutTop(c.cwd);
  if (top === null) return false;
  if (review) {
    const branch = review[1] ?? '';
    return isBranchName(branch) && c.remoteRefExists(top, branch);
  }
  if (!own) return true;
  const [, branch = '', start] = own;
  const prefix = p.ownBranchPrefix;
  return (
    prefix !== null &&
    branch.length > prefix.length &&
    branch.startsWith(prefix) &&
    isBranchName(branch) &&
    start === p.integrationBranch
  );
}

/** The folder a command runs in and the command itself: `cd PATH && rest`, or `cwd`. Null for a
 * `..` segment (node folds it as text, bash after following a link) and, on Windows, a leading `/`
 * (Git Bash's own root, not this drive's). */
function placed(command: string, cwd: string): { dir: string; rest: string } | null {
  const m = CD_AND.exec(command);
  if (!m) return { dir: cwd, rest: command };
  const path = m[1] ?? m[2] ?? '';
  if (path.split('/').includes('..') || (sep === '\\' && path.startsWith('/'))) return null;
  return { dir: resolve(cwd, path), rest: m[3] ?? '' };
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

/** A test or delivery command, bare or after `cd PATH &&`: it passes only in a mesh worktree on
 * the window's own branch. Test commands are compared by string equality, never by pattern. */
function inWorktree(command: string, c: CommandContext, p: WindowPolicy): CommandDecision {
  const at = placed(command, c.cwd);
  if (at === null) return ask(UNLISTED);
  const test = p.testCommands.includes(at.rest);
  if (!test && !isDelivery(at.rest)) return ask(UNLISTED);
  const wt = c.worktreeOf(at.dir);
  const branch = wt?.branch ?? null;
  const prefix = p.ownBranchPrefix;
  const own = branch !== null && prefix !== null && branch.startsWith(prefix);
  if (test) return own ? pass() : ask(wt ? foreign(branch) : TEST_OUTSIDE);
  return own && delivers(at.rest, branch, p) ? pass() : ask(UNLISTED);
}

/** Whether `command` may go on to Claude Code's permission flow, or must ask the human. */
export function classifyCommand(command: string, c: CommandContext): CommandDecision {
  const p = c.policy;
  if (!p) return ask(NO_POLICY);
  if (typeof command !== 'string' || typeof c.cwd !== 'string') return ask(UNLISTED);
  if (EXACT.has(command) || reads(command) || CD.test(command)) return pass();
  const change = worktreeChange(command, c, p);
  if (change !== null) return change ? pass() : ask(UNLISTED);
  return inWorktree(command, c, p);
}
