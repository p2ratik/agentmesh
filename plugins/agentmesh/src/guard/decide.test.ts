import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { policy } from './commands.fixture';
import { ACTIVATE_TOOL, decide, type GuardContext } from './decide';
import { fixture, mesh, put } from './paths.fixture';

// The real checkout readers, with a switch that makes checkoutTop throw (no input does today).
const boom = vi.hoisted(() => ({ on: false }));
vi.mock('./checkout', async (original) => {
  const real = await original<typeof import('./checkout')>();
  return {
    ...real,
    checkoutTop: (...a: Parameters<typeof real.checkoutTop>) => {
      if (boom.on) throw new Error('boom');
      return real.checkoutTop(...a);
    },
  };
});

let base: string;
let repo: string;
let ctx: GuardContext;

beforeEach(() => {
  const f = fixture();
  ({ base, repo } = f);
  ctx = { marked: true, policy, home: f.o.home, platform: f.o.platform };
  boom.on = false;
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const call = (tool_name: string, tool_input: unknown, cwd = repo) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  cwd,
});

const PASS = { kind: 'pass' };
const deny = (reason: string) => ({ kind: 'deny', reason });
const ask = (reason: string) => ({ kind: 'ask', reason });
const UNREADABLE = deny('mesh window: the guard could not read this tool call, so it is refused');
const UNLISTED = ask("mesh window: this command isn't on the window's list, so your human decides");

describe('decide', () => {
  it('does nothing outside the mesh window', () => {
    const unmarked = { ...ctx, marked: false };
    expect(decide(null, unmarked)).toEqual(PASS);
    expect(decide(call('Edit', { file_path: 'C:/x.ts' }), unmarked)).toEqual(PASS);
    expect(decide(call('Glob', {}), unmarked)).toEqual(PASS);
  });

  it('fails closed on a call it cannot read', () => {
    for (const input of [null, undefined, 'x', 42, [], {}, { tool_input: {} }]) {
      expect(decide(input, ctx)).toEqual(UNREADABLE);
    }
    expect(decide({ tool_name: 'Edit' }, ctx)).toEqual(UNREADABLE);
    expect(decide(call('Edit', 'x'), ctx)).toEqual(UNREADABLE);
    expect(decide(call('Bash', null), ctx)).toEqual(UNREADABLE);
  });

  it('refuses an edit with no path', () => {
    const none = deny('mesh window: this edit names no file, so it is refused');
    expect(decide(call('Write', { content: 'x' }), ctx)).toEqual(none);
    expect(decide(call('Edit', { file_path: '' }), ctx)).toEqual(none);
    expect(decide(call('NotebookEdit', { new_source: 'x' }), ctx)).toEqual(none);
  });

  it('refuses a tool it does not know', () => {
    expect(decide(call('Glob', { pattern: '**' }), ctx)).toEqual(
      deny('mesh window: the guard does not know Glob, so it is refused'),
    );
  });

  it('refuses an edit outside a task worktree', () => {
    const d = decide(call('Edit', { file_path: join(repo, 'src', 'a.ts') }), ctx);
    expect(d).toEqual(
      deny('mesh window: work only inside a task worktree (not inside .claude/worktrees/mesh-*)'),
    );
    expect(decide(call('Write', { file_path: 'src/a.ts' }), ctx)).toMatchObject({
      kind: 'deny',
      reason: expect.stringMatching(/^mesh window: work only inside a task worktree \(/),
    });
  });

  it('lets an edit inside a registered mesh worktree through', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    put(join(wt, 'a.ts'));
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(decide(call(tool, { file_path: join(wt, 'a.ts') }), ctx)).toEqual(PASS);
    }
    const notebook = { notebook_path: join(wt, 'n.ipynb'), new_source: 'x' };
    expect(decide(call('NotebookEdit', notebook), ctx)).toEqual(PASS);
  });

  it('checks every path an edit names', () => {
    const wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
    const both = { notebook_path: join(wt, 'n.ipynb'), file_path: join(repo, 'src', 'a.ts') };
    for (const tool of ['Edit', 'NotebookEdit']) {
      expect(decide(call(tool, both), ctx)).toMatchObject({ kind: 'deny' });
    }
    const odd = { notebook_path: join(wt, 'n.ipynb'), file_path: 7 };
    expect(decide(call('NotebookEdit', odd), ctx)).toMatchObject({ kind: 'deny' });
  });

  it('refuses EnterWorktree', () => {
    expect(decide(call('EnterWorktree', { name: 'x' }), ctx)).toEqual(
      deny(
        'mesh window: stay in this folder; make worktrees with git worktree add .claude/worktrees/mesh-…',
      ),
    );
  });

  it('asks for PowerShell and Monitor', () => {
    for (const tool of ['PowerShell', 'Monitor']) {
      expect(decide(call(tool, { command: 'git status' }), ctx)).toEqual(
        ask(`mesh window: ${tool} commands need your human's approval here`),
      );
    }
  });

  it('stamps the activate call', () => {
    expect(decide(call(ACTIVATE_TOOL, {}), ctx)).toEqual({ kind: 'stamp' });
    expect(decide(call(ACTIVATE_TOOL, {}), { ...ctx, policy: null })).toEqual({ kind: 'stamp' });
  });

  it('passes Bash to the command list', () => {
    expect(decide(call('Bash', { command: 'git status' }), ctx)).toEqual(PASS);
    expect(decide(call('Bash', { command: 'git push' }), ctx)).toEqual(UNLISTED);
    expect(decide(call('Bash', { command: 'git status' }), { ...ctx, policy: null })).toEqual(
      ask(
        "mesh window: ~/.agentmesh/mesh-window.json is missing or invalid, so every command needs your human's approval",
      ),
    );
  });

  it('places Bash with the call’s cwd and the real worktree reader', () => {
    const wt = mesh(repo, 'mesh-task-1-a', 'agent/pratik/task-1-a');
    const theirs = mesh(repo, 'mesh-review-2', 'agent/sagar/task-2-x');
    expect(decide(call('Bash', { command: 'pnpm check' }, wt), ctx)).toEqual(PASS);
    expect(decide(call('Bash', { command: 'pnpm check' }, theirs), ctx)).toEqual(
      ask(
        "mesh window: agent/sagar/task-2-x isn't your branch, so running its tests needs your human's approval",
      ),
    );
    expect(decide(call('Bash', { command: 'pnpm check' }), ctx)).toEqual(
      ask('mesh window: run tests inside a task worktree (cd <worktree> && <test>)'),
    );
  });

  it('passes the real checkout readers to the command list', () => {
    put(join(repo, '.git', 'refs', 'remotes', 'origin', 'agents'), `${'a'.repeat(40)}\n`);
    mesh(repo, 'mesh-taken', 'agent/pratik/taken');
    const add = (slug: string) =>
      `git worktree add .claude/worktrees/${slug} -b agent/pratik/${slug} --track origin/agents`;
    expect(decide(call('Bash', { command: add('mesh-task-9-x') }), ctx)).toEqual(PASS);
    // freeSlot: the slot is already a worktree
    expect(decide(call('Bash', { command: add('mesh-taken') }), ctx)).toEqual(UNLISTED);
    // checkoutTop: not the top of a checkout
    const sub = join(repo, 'src');
    mkdirSync(sub, { recursive: true });
    expect(decide(call('Bash', { command: add('mesh-task-9-x') }, sub), ctx)).toEqual(UNLISTED);
    // remoteRefExists: a review worktree only of a branch the checkout has fetched
    const review = (b: string) =>
      `git worktree add .claude/worktrees/mesh-r refs/remotes/origin/${b}`;
    expect(decide(call('Bash', { command: review('agents') }), ctx)).toEqual(PASS);
    expect(decide(call('Bash', { command: review('agent/sagar/none') }), ctx)).toEqual(UNLISTED);
  });

  it('asks when a reader throws, and never throws itself', () => {
    boom.on = true;
    expect(decide(call('Bash', { command: 'git worktree list' }), ctx)).toEqual(PASS);
    expect(
      decide(call('Bash', { command: 'git worktree remove .claude/worktrees/mesh-a' }), ctx),
    ).toEqual(UNLISTED);
  });
});
