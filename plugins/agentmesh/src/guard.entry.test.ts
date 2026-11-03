import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVATE_TOOL } from './guard/decide';

// The guard entry as Claude Code runs it: a process with the hook input on stdin. tsx stands in
// for the bundle (Task 12 smoke-tests dist/guard.js); home is a temp folder, never the real one.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MARK = '0123456789abcdef0123456789abcdef';
const edit = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: 'C:/x.ts' },
  cwd: ROOT,
};

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'am-guard-entry-'));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Runs the guard with `input` on stdin, or with `stdin` (a file descriptor) in its place. */
function guard(input: unknown, env: Record<string, string>, stdin?: number) {
  const clean = { ...process.env };
  for (const k of ['AGENTMESH_MESH_WINDOW', 'CLAUDE_PLUGIN_DATA']) delete clean[k];
  const home = join(base, 'home');
  return spawnSync(process.execPath, ['--import', 'tsx', 'plugins/agentmesh/src/guard.ts'], {
    cwd: ROOT,
    ...(stdin === undefined
      ? { input: JSON.stringify(input) }
      : { stdio: [stdin, 'pipe', 'pipe'] }),
    env: { ...clean, HOME: home, USERPROFILE: home, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

/** A stdin the guard can't read: a file opened only for writing. */
function unreadable<T>(run: (fd: number) => T): T {
  const fd = openSync(join(base, 'write-only'), 'w');
  try {
    return run(fd);
  } finally {
    closeSync(fd);
  }
}

describe('dist/guard.js (from source)', () => {
  it('does nothing outside the mesh window', () => {
    const r = guard(edit, {});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('refuses an edit outside a task worktree in the mesh window', () => {
    const r = guard(edit, { AGENTMESH_MESH_WINDOW: MARK });
    expect(r.status).toBe(2);
    expect(r.stderr.startsWith('mesh window: work only inside a task worktree')).toBe(true);
  });

  it('stamps the activate call', () => {
    const data = join(base, 'data');
    const r = guard(
      { hook_event_name: 'PreToolUse', tool_name: ACTIVATE_TOOL, tool_input: {}, cwd: ROOT },
      { AGENTMESH_MESH_WINDOW: MARK, CLAUDE_PLUGIN_DATA: data },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(join(data, 'guard-alive.json'))).toBe(true);
  });

  it('refuses the call when it fails in the mesh window', () => {
    // the stamp can't be written: its folder would sit under a file
    const blocked = join(base, 'file');
    writeFileSync(blocked, '');
    const activate = { hook_event_name: 'PreToolUse', tool_name: ACTIVATE_TOOL, tool_input: {} };
    const env = { AGENTMESH_MESH_WINDOW: MARK, CLAUDE_PLUGIN_DATA: join(blocked, 'data') };
    for (const r of [guard(activate, env), unreadable((fd) => guard(null, env, fd))]) {
      expect(r.status).toBe(2);
      expect(r.stderr).toBe('mesh window: the guard failed on this call, so it is refused');
    }
  });

  it('never fails outside the mesh window', () => {
    const r = unreadable((fd) => guard(null, {}, fd));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });
});
