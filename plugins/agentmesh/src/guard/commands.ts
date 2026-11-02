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

/** A read-only command's argument: no shell metacharacter, and never git's `--output` (git takes
 * no abbreviation of it). */
const SAFE = '(?!--output)[A-Za-z0-9._/:@^~=,-]+';
/** A path bash and node read alike: no leading dash (`cd -` is OLDPWD, `-P` an option), and a
 * colon only after a drive letter (`C:t` and `a:b` mean other things on Windows). Plain, or in
 * double quotes with spaces. */
const PATH_RAW = '(?!-)(?:[A-Za-z]:(?=/))?[A-Za-z0-9._/-]+';
const PATH_QUOTED = '(?!-)(?:[A-Za-z]:(?=/))?[A-Za-z0-9._/ -]+';
const PATH = `(?:${PATH_RAW}|"${PATH_QUOTED}")`;
/** A single-quoted message: printable ASCII without `'` or `\`, so no shell (fish reads `\'`,
 * PowerShell reads curly quotes) ends it early. */
const MESSAGE = String.raw`'[\x20-\x26\x28-\x5b\x5d-\x7e]*'`;
const BRANCH = '([A-Za-z0-9][A-Za-z0-9._/-]*)';
const MESH = String.raw`\.claude/worktrees/mesh-[a-z0-9][a-z0-9-]{0,62}`;

const EXACT = new Set(['pwd', 'git status', 'git fetch origin', 'git worktree list']);
const READ = new RegExp(`^(?:ls|git (?:diff|log|show))(?: ${SAFE})*$`);
const CD = new RegExp(`^cd ${PATH}$`);
const WORKTREE_ADD = new RegExp(`^git worktree add ${MESH} (?:-b ${BRANCH} )?origin/${BRANCH}$`);
const WORKTREE_REMOVE = new RegExp(`^git worktree remove ${MESH}$`);
const CD_AND = new RegExp(`^cd (?:(${PATH_RAW})|"(${PATH_QUOTED})") && (.+)$`);
const ADD = new RegExp(`^git add (?:-A|--(?: ${PATH})+)$`);
const COMMIT = new RegExp(`^git commit(?: -m ${MESSAGE})+$`);
const PUSH = new RegExp(`^git push (?:-u )?origin ${BRANCH}$`);
const PR = new RegExp(
  `^gh pr create --base ${BRANCH} --head ${BRANCH}(?: --title ${MESSAGE})?(?: --body ${MESSAGE})?$`,
);

/** `git worktree add|remove` of a mesh worktree, run from a checkout: never inside a mesh
 * worktree, whose branch could commit `.claude/worktrees` as a link that git would write through. */
function worktreeChange(command: string, c: CommandContext, p: WindowPolicy): boolean | null {
  const add = WORKTREE_ADD.exec(command);
  if (!add && !WORKTREE_REMOVE.test(command)) return null;
  if (c.worktreeOf(c.cwd) !== null) return false;
  if (!add) return true;
  const [, branch, start = ''] = add;
  if (branch === undefined) return isBranchName(start);
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
  if (EXACT.has(command) || READ.test(command) || CD.test(command)) return pass();
  const change = worktreeChange(command, c, p);
  if (change !== null) return change ? pass() : ask(UNLISTED);
  return inWorktree(command, c, p);
}
