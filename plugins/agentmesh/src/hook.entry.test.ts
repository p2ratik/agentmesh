import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowFiles } from '@agentmesh/common/window';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WINDOW_LABEL } from './hook/prompt';
import { HINT_SETUP, HINT_START } from './window/session-start';

// The prompt hook as Claude Code runs it: a process with the event on stdin. tsx stands in for the
// bundle; home and plugin data are temp folders, never the real ones.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ARGS = ['--import', 'tsx', 'plugins/agentmesh/src/hook.ts'];

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'am-hook-entry-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Runs the hook with `stdin`; the hook may stop reading a long one, so a broken pipe is fine. */
async function hook(stdin: string, env: Record<string, string>) {
  const clean = { ...process.env };
  for (const k of ['AGENTMESH_MESH_WINDOW', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PID']) delete clean[k];
  const home = join(base, 'home');
  const child = spawn(process.execPath, ARGS, {
    cwd: ROOT,
    env: {
      ...clean,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_DATA: join(base, 'data'),
      ...env,
    },
  });
  let stdout = '';
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin);
  const status = await new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  return { status, stdout };
}

const turn = (body: string) =>
  JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt: `<cross-session-message from="uds:x" from-name="y">\n${body}\n</cross-session-message>`,
  });

describe('dist/hook.js (from source)', () => {
  it('labels a cross-session turn over its stdin limit in the mesh window', async () => {
    const big = turn('a'.repeat(1_100_000));
    expect(big.length).toBeGreaterThan(1_000_000);
    const r = await hook(big, { AGENTMESH_MESH_WINDOW: 'x' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: WINDOW_LABEL },
    });
    // the same for a short one, and nothing outside the window
    expect(JSON.parse((await hook(turn('hi'), { AGENTMESH_MESH_WINDOW: 'x' })).stdout)).toEqual(
      JSON.parse(r.stdout),
    );
    expect(await hook(big, {})).toEqual({ status: 0, stdout: '' });
  }, 30_000);

  it('keeps the conversation id by CLAUDE_PID from session start to session end', async () => {
    const data = join(base, 'data');
    mkdirSync(data, { recursive: true });
    const stale = join(data, 'cc-1.json');
    writeFileSync(stale, '{}');
    utimesSync(stale, new Date(0), new Date(0));
    const id = '0b6c1a52-3e9f-4d2a-9c11-5f2e8a7d4b10';
    const OTHER = '7d1e0c3a-2b4f-4e6a-8c9d-1a2b3c4d5e6f';
    const env = { CLAUDE_PID: '4242' };
    const start = { hook_event_name: 'SessionStart', source: 'clear', session_id: id };
    expect((await hook(JSON.stringify(start), env)).status).toBe(0);
    const record = JSON.parse(readFileSync(join(data, 'cc-4242.json'), 'utf8'));
    expect(record).toEqual({ session_id: id, source: 'clear', at: expect.any(String) });
    expect(existsSync(stale)).toBe(false);
    // The conversation /clear ended, reported after the new one started: its record stays.
    const old = { hook_event_name: 'SessionEnd', reason: 'clear', session_id: OTHER };
    expect(await hook(JSON.stringify(old), env)).toEqual({ status: 0, stdout: '' });
    expect(readdirSync(data)).toEqual(['cc-4242.json']);
    const end = { hook_event_name: 'SessionEnd', reason: 'exit', session_id: id };
    expect(await hook(JSON.stringify(end), env)).toEqual({ status: 0, stdout: '' });
    expect(readdirSync(data)).toEqual([]);
  }, 30_000);

  it("hints to start the window only when the policy file is this agent's", async () => {
    const policy = windowFiles(join(base, 'home'), process.platform).policy;
    mkdirSync(join(policy, '..'), { recursive: true });
    const start = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' });
    const env = { CLAUDE_PLUGIN_OPTION_AGENT_ID: 'alice-agent' };
    const hint = async () => JSON.parse((await hook(start, env)).stdout).systemMessage;
    const write = (agentId: string) =>
      writeFileSync(
        policy,
        JSON.stringify({
          version: 1,
          agentId,
          token: 'a'.repeat(32),
          ownBranchPrefix: null,
          integrationBranch: 'agents',
          testCommands: [],
        }),
      );
    expect(await hint()).toBe(HINT_SETUP);
    write('alice-agent');
    expect(await hint()).toBe(HINT_START);
    write('bob-agent');
    expect(await hint()).toBe(HINT_SETUP);
    writeFileSync(policy, '{not json');
    expect(await hint()).toBe(HINT_SETUP);
  }, 30_000);
});
