import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WINDOW_LABEL } from './hook/prompt';

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
});
