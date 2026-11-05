import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIST_AGENTS, SEND_DENIED } from './guard/send';
import { WINDOW_LABEL } from './hook/prompt';
import { FORWARD_TTL_MS, writeForward } from './relay/forward-record';
import { type LocalSession, localSessionFile, replyNote } from './relay/local-session';
import { pointerText } from './relay/pointer';

// The committed bundles themselves, run with plain node as Claude Code runs them: the event on
// stdin, a temp home and data folder, and no inherited CLAUDE_* or AGENTMESH_* variables. The
// entry tests cover the same code from source; these catch a bundle that lags behind it.
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const MARK = '0123456789abcdef0123456789abcdef';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'am-bundles-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const data = () => join(base, 'data');

function run(bundle: 'hook' | 'guard', input: unknown, env: Record<string, string> = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|AGENTMESH_)/i.test(k)),
  );
  const home = join(base, 'home');
  return spawnSync(process.execPath, [join(DIST, `${bundle}.js`)], {
    input: JSON.stringify(input),
    env: { ...clean, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: data(), ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

const context = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.additionalContext;
const tool = (tool_name: string, tool_input: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  cwd: base,
});

describe('the built hook and guard bundles', () => {
  it('import node built-ins only, and no zod', () => {
    for (const bundle of ['hook', 'guard']) {
      const source = readFileSync(join(DIST, `${bundle}.js`), 'utf8');
      expect(source, bundle).not.toMatch(/zod/i);
      const imports = source.match(/from ["'][^"']+["']/g) ?? [];
      expect(
        imports.every((i) => i.includes('node:')),
        bundle,
      ).toBe(true);
    }
  });

  it('the guard refuses SendMessage and ListAgents in the mesh window', () => {
    const env = { AGENTMESH_MESH_WINDOW: MARK };
    const to = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${'a'.repeat(32)}`;
    const send = { to, recipient: to, type: 'message', message: 'hi', content: 'hi' };
    expect(run('guard', tool('SendMessage', send), env)).toMatchObject({
      status: 2,
      stderr: SEND_DENIED,
    });
    expect(run('guard', tool('ListAgents', {}), env)).toMatchObject({
      status: 2,
      stderr: LIST_AGENTS,
    });
  });

  it.runIf(process.platform === 'win32')('the guard passes a pushed pointer once', () => {
    const hex = 'b'.repeat(32);
    const to = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`;
    const fields = { from: 'alice-agent', threadId: 'thr-7', messageId: `msg-${'0'.repeat(26)}` };
    writeForward(data(), hex, fields, Date.now() + FORWARD_TTL_MS);
    const message = pointerText(fields) ?? '';
    const send = { to, recipient: to, type: 'message', message, content: message };
    const env = { AGENTMESH_MESH_WINDOW: MARK };
    expect(run('guard', tool('SendMessage', send), env)).toMatchObject({ status: 0, stderr: '' });
    expect(run('guard', tool('SendMessage', send), env)).toMatchObject({ status: 2 });
  });

  it('the hook labels a cross-session turn in the mesh window', () => {
    const prompt =
      '<cross-session-message from="uds:x" from-name="y">\nhi\n</cross-session-message>';
    const r = run(
      'hook',
      { hook_event_name: 'UserPromptSubmit', prompt },
      {
        AGENTMESH_MESH_WINDOW: MARK,
      },
    );
    expect(r.status).toBe(0);
    expect(context(r.stdout)).toBe(WINDOW_LABEL);
  });

  it('the hook shows a private session its reply note, found by CLAUDE_PID', () => {
    const record: LocalSession = {
      agentId: 'bob-agent',
      prefix: 'mesh',
      hubSessionId: 's-aaaaaaaaaaaa',
      uds: null,
      claudePid: 4242,
      claudeSessionId: null,
      projectDir: base,
      relay: true,
      threads: 2,
      from: ['alice-agent'],
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(data(), { recursive: true });
    const name = localSessionFile('mesh', 'bob-agent', 's-aaaaaaaaaaaa') ?? '';
    writeFileSync(join(data(), name), JSON.stringify(record));
    const prompt = { hook_event_name: 'UserPromptSubmit', prompt: 'go on' };
    const r = run('hook', prompt, { CLAUDE_PID: '4242' });
    expect(context(r.stdout)).toBe(replyNote(record));
    expect(run('hook', prompt, { CLAUDE_PID: '4243' }).stdout).toBe('');
  });

  it('the hook writes cc-<CLAUDE_PID>.json at session start and deletes it at its end', () => {
    const id = '0b6c1a52-3e9f-4d2a-9c11-5f2e8a7d4b10';
    const other = '7d1e0c3a-2b4f-4e6a-8c9d-1a2b3c4d5e6f';
    const file = join(data(), 'cc-4242.json');
    const env = { CLAUDE_PID: '4242' };
    expect(run('hook', { hook_event_name: 'SessionStart', session_id: id }, env).status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).session_id).toBe(id);
    run('hook', { hook_event_name: 'SessionEnd', session_id: other }, env);
    expect(existsSync(file)).toBe(true);
    run('hook', { hook_event_name: 'SessionEnd', session_id: id }, env);
    expect(existsSync(file)).toBe(false);
  });
});
