import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportedEvent } from '@agentmesh/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVATE_TOOL } from './guard/decide';
import { SEND_DENIED } from './guard/send';
import { FORWARD_TTL_MS, writeForward } from './relay/forward-record';
import { pointerText } from './relay/pointer';

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

const ARGS = ['--import', 'tsx', 'plugins/agentmesh/src/guard.ts'];

/** The test's environment without any mesh window or plugin data of its own, over a temp home. */
function environment(env: Record<string, string>): NodeJS.ProcessEnv {
  const clean = { ...process.env };
  for (const k of ['AGENTMESH_MESH_WINDOW', 'CLAUDE_PLUGIN_DATA']) delete clean[k];
  // Options inherited from a Claude Code session running these tests are stubbed empty.
  for (const k of Object.keys(clean)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) clean[k] = '';
  const home = join(base, 'home');
  return { ...clean, HOME: home, USERPROFILE: home, ...env };
}

/** Runs the guard with `input` on stdin, or with `stdin` (a file descriptor) in its place. */
function guard(input: unknown, env: Record<string, string>, stdin?: number) {
  return spawnSync(process.execPath, ARGS, {
    cwd: ROOT,
    ...(stdin === undefined
      ? { input: JSON.stringify(input) }
      : { stdio: [stdin, 'pipe', 'pipe'] }),
    env: environment(env),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

/** Runs the guard with `partial` written to a stdin that is never closed; killed after 10 s. */
async function guardOpenStdin(partial: string) {
  const child = spawn(process.execPath, ARGS, { cwd: ROOT, env: environment({}) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  child.stderr.on('data', (c) => {
    stderr += c;
  });
  child.stdin.write(partial);
  const kill = setTimeout(() => child.kill(), 10_000);
  const status = await new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  clearTimeout(kill);
  child.stdin.destroy();
  return { status, stdout, stderr };
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

  it('stops waiting for stdin after a second outside the mesh window', async () => {
    const started = Date.now();
    const r = await guardOpenStdin('{"tool_name":"Edit","tool_input":');
    expect(r).toEqual({ status: 0, stdout: '', stderr: '' });
    // The guard gives up after 1 s; the rest is a cold tsx start on a loaded CI runner.
    expect(Date.now() - started).toBeLessThan(5000);
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

  it('never fails outside the mesh window, and records nothing there', () => {
    const data = join(base, 'data');
    const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_AGENT_ID: 'alice-agent' };
    const r = unreadable((fd) => guard(null, env, fd));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(lines(data)).toEqual([]);
    expect(existsSync(join(base, 'home'))).toBe(false);
  });
});

/** The event lines the guard left in `dir`, each checked with the shipper's schema. */
function lines(dir: string): ReportedEvent[] {
  const names = existsSync(dir)
    ? readdirSync(dir).filter((n) => /^events-(?:[a-z0-9-]+-)?\d+\.jsonl$/.test(n))
    : [];
  return names.flatMap((n) =>
    readFileSync(join(dir, n), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => ReportedEvent.parse(JSON.parse(l))),
  );
}

const HEX = 'c'.repeat(32);
const TO = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${HEX}`;
const FIELDS = { from: 'alice-agent', threadId: 'thr-9', messageId: `msg-${'2'.repeat(26)}` };
const POINTER = pointerText(FIELDS) ?? '';
const sendCall = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'SendMessage',
  tool_input: {
    to: TO,
    recipient: TO,
    type: 'message',
    message: POINTER,
    content: POINTER,
    ...extra,
  },
  cwd: ROOT,
});

describe('the guard leaves events for the timeline', () => {
  it('appends one guard line with the code for a denied SendMessage, and no text', () => {
    const data = join(base, 'data');
    const env = { AGENTMESH_MESH_WINDOW: MARK, CLAUDE_PLUGIN_DATA: data };
    const r = guard(sendCall({ notify_when_idle: true }), env);
    expect(r).toMatchObject({ status: 2, stderr: SEND_DENIED });
    const [line, ...rest] = lines(data);
    expect(rest).toEqual([]);
    expect(line).toEqual({
      id: expect.any(String),
      at: expect.any(String),
      session: null,
      source: 'guard',
      kind: 'guard',
      tool: 'SendMessage',
      decision: 'deny',
      reason: 'send.unknown_key',
      key: 'notify_when_idle',
    });
    expect(JSON.stringify(line)).not.toContain('AgentMesh:');
  });

  it.runIf(process.platform === 'win32')('appends relay claimed when SendMessage passes', () => {
    const data = join(base, 'data');
    writeForward(data, HEX, FIELDS, Date.now() + FORWARD_TTL_MS);
    const r = guard(sendCall(), { AGENTMESH_MESH_WINDOW: MARK, CLAUDE_PLUGIN_DATA: data });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(lines(data)).toEqual([
      expect.objectContaining({
        source: 'guard',
        kind: 'relay',
        stage: 'claimed',
        message: FIELDS.messageId,
        thread: FIELDS.threadId,
      }),
    ]);
  });

  it('records an ask, and the failure it refuses, with codes', () => {
    const data = join(base, 'data');
    const env = { AGENTMESH_MESH_WINDOW: MARK, CLAUDE_PLUGIN_DATA: data };
    const bash = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    expect(guard({ ...bash, cwd: ROOT }, env).status).toBe(0);
    const failed = unreadable((fd) => guard(null, env, fd));
    expect(failed).toMatchObject({
      status: 2,
      stderr: 'mesh window: the guard failed on this call, so it is refused',
    });
    expect(lines(data).map((e) => e.kind === 'guard' && [e.tool, e.decision, e.reason])).toEqual(
      expect.arrayContaining([
        ['Bash', 'ask', 'marker.unverified'],
        ['unknown', 'deny', 'guard.error'],
      ]),
    );
  });

  it('decides exactly the same when the events file cannot be written', () => {
    const blocked = join(base, 'file');
    writeFileSync(blocked, '');
    const env = { AGENTMESH_MESH_WINDOW: MARK, CLAUDE_PLUGIN_DATA: join(blocked, 'data') };
    const open = { AGENTMESH_MESH_WINDOW: MARK, CLAUDE_PLUGIN_DATA: join(base, 'data') };
    const bash = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    for (const call of [edit, sendCall({ cc: 1 }), { ...bash, cwd: ROOT }]) {
      const pick = ({ status, stdout, stderr }: ReturnType<typeof guard>) => ({
        status,
        stdout,
        stderr,
      });
      expect(pick(guard(call, env))).toEqual(pick(guard(call, open)));
    }
    expect(lines(join(base, 'data'))).toHaveLength(3);
  });

  it('writes nothing outside the mesh window', () => {
    const data = join(base, 'data');
    expect(guard(sendCall({ cc: 1 }), { CLAUDE_PLUGIN_DATA: data }).status).toBe(0);
    expect(lines(data)).toEqual([]);
    expect(existsSync(join(base, 'home'))).toBe(false);
  });

  it('names its file by agent, and leaves no unnamed file in the shared folder', () => {
    const run = join(base, 'home', '.agentmesh', 'run');
    const deny = sendCall({ cc: 1 });
    guard(deny, { AGENTMESH_MESH_WINDOW: MARK });
    expect(lines(run)).toEqual([]);
    guard(deny, { AGENTMESH_MESH_WINDOW: MARK, CLAUDE_PLUGIN_OPTION_AGENT_ID: 'alice-agent' });
    expect(readdirSync(run)).toEqual([expect.stringMatching(/^events-alice-agent-\d+\.jsonl$/)]);
    expect(lines(run)).toMatchObject([{ kind: 'guard', reason: 'send.unknown_key', key: 'cc' }]);
  });
});
