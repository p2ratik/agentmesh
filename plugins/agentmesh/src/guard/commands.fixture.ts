// Fixtures for the guard's command tests: the window's policy, its own task worktree (in a folder
// with a space) and a teammate's review worktree, behind a worktreeOf stub keyed by resolve(dir).
import { resolve } from 'node:path';
import type { WindowPolicy } from '@agentmesh/common/window';
import { expect } from 'vitest';
import { checkoutTop, freeSlot, remoteRefExists } from './checkout';
import { type CommandContext, classifyCommand } from './commands';
import { type MeshWorktree, meshWorktreeOf, type PathOptions } from './paths';

export const win32 = process.platform === 'win32';

/** The command context as production (decide.ts) builds it, from the real readers. */
export function realContext(o: PathOptions, cwd: string, over: Partial<CommandContext> = {}) {
  return {
    policy,
    cwd,
    worktreeOf: (dir: string) => {
      const w = meshWorktreeOf(dir, o);
      return 'refused' in w ? null : w;
    },
    checkoutTop: (dir: string) => checkoutTop(dir, o),
    remoteRefExists: (top: string, branch: string) => remoteRefExists(top, branch, o),
    freeSlot: (top: string, name: string) => freeSlot(top, name, o),
    ...over,
  } satisfies CommandContext;
}

export const policy: WindowPolicy = {
  version: 1,
  agentId: 'pratik-agent',
  token: '0123456789abcdef0123456789abcdef',
  ownBranchPrefix: 'agent/pratik/',
  integrationBranch: 'agents',
  testCommands: ['pnpm check'],
};

const worktree = (repo: string, name: string, branch: string | null): MeshWorktree => ({
  root: resolve(repo, '.claude', 'worktrees', name),
  gitDir: resolve(repo, '.git', 'worktrees', name),
  branch,
});

export const own = worktree('/t/John Smith/web', 'mesh-task-3-login', 'agent/pratik/task-3-login');
export const theirs = worktree('/t/web', 'mesh-review-task-2', 'agent/sagar/task-2-x');
export const detached = worktree('/t/web', 'mesh-detached', null);

/** A folder as a command spells it: forward slashes (`G:/t/…` on Windows, `/t/…` elsewhere). */
export const slash = (p: string) => p.replaceAll('\\', '/');
export const OWN = slash(own.root);
export const THEIRS = slash(theirs.root);

/** Checkout tops (a real `.git` folder), the remote branches they have fetched, a worktree slot
 * already taken in each, and a folder that is neither a checkout nor a worktree on any drive
 * (`resolve('/t')` is `C:\t`, a top, when the tests run from drive C:). */
export const TOPS = ['C:/t', '/t/web', '/t/John Smith/web'].map((d) => resolve(d));
export const REMOTES = ['agents', 'agent/sagar/task-2-x', 'agent/sagar/y'];
export const TAKEN = 'mesh-taken';
export const ELSEWHERE = resolve('/t/elsewhere');

export function ctx(cwd: string, over: Partial<CommandContext> = {}): CommandContext {
  const known = new Map([own, theirs, detached].map((w) => [resolve(w.root), w]));
  return {
    policy,
    cwd,
    worktreeOf: (dir) => known.get(resolve(dir)) ?? null,
    checkoutTop: (dir) => (TOPS.includes(resolve(dir)) ? resolve(dir) : null),
    remoteRefExists: (top, branch) => TOPS.includes(top) && REMOTES.includes(branch),
    freeSlot: (top, name) => TOPS.includes(top) && name !== TAKEN,
    ...over,
  };
}

export type Decision = ReturnType<typeof classifyCommand>;

/** Each command's decision, keyed by the command, so a failure names the command. */
export function decide(cwd: string, commands: string[], over: Partial<CommandContext> = {}) {
  return Object.fromEntries(commands.map((c) => [c, classifyCommand(c, ctx(cwd, over))]));
}

export const every = (commands: string[], d: Decision) =>
  Object.fromEntries(commands.map((c) => [c, d]));

/** Every command gives the generic reason, by default in the window's own worktree. */
export const asksAll = (commands: string[], cwd = own.root) =>
  expect(decide(cwd, commands)).toEqual(every(commands, UNLISTED));

export const B = 'agent/pratik/task-3-login';

export const PASS: Decision = { pass: true };
export const NO_POLICY: Decision = {
  ask: "mesh window: ~/.agentmesh/mesh-window.json is missing or invalid, so every command needs your human's approval",
};
export const OUTSIDE: Decision = {
  ask: 'mesh window: run tests inside a task worktree (cd <worktree> && <test>)',
};
export const UNLISTED: Decision = {
  ask: "mesh window: this command isn't on the window's list, so your human decides",
};
export const foreign = (branch: string): Decision => ({
  ask: `mesh window: ${branch} isn't your branch, so running its tests needs your human's approval`,
});
