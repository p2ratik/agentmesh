import { homedir } from 'node:os';
import { MESH_WINDOW_ENV, readMarker } from '@agentmesh/common/window';
import { decide } from './guard/decide';
import { hookOutput, readAll } from './guard/io';
import { pullStateDirs } from './pull/state';
import { writeGuardStamp } from './window/guard-stamp';

/**
 * The worktree guard, the plugin's PreToolUse hook (dist/guard.js). It runs in every session but
 * acts only in the mesh window: there it denies (exit 2) or asks, and writes the liveness stamp on
 * the activate call; anywhere else it reads stdin for at most a second and exits 0, whatever
 * happens, because `onFailure: "block"` would turn a failure into a blocked edit. Node built-ins
 * only: it runs before every edit and shell call.
 */

const UNMARKED_STDIN_MS = 1000;
const FAILED = 'mesh window: the guard failed on this call, so it is refused';

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main(marked: boolean): Promise<0 | 2> {
  const text = await readAll(process.stdin, marked ? null : UNMARKED_STDIN_MS);
  process.stdin.destroy();
  if (!marked) return 0;
  const env = process.env;
  const home = homedir();
  const platform = process.platform;
  const { policy } = readMarker(env, home, platform);
  const decision = decide(parse(text), { marked, policy, home, platform });
  if (decision.kind === 'stamp') {
    const dir = pullStateDirs(env, home)[0];
    if (!dir) throw new Error('no plugin data folder');
    writeGuardStamp(dir, new Date());
  }
  const out = hookOutput(decision);
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  return out.exitCode;
}

const marked = !!process.env[MESH_WINDOW_ENV];
main(marked).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    if (marked) process.stderr.write(FAILED);
    process.exitCode = marked ? 2 : 0;
  },
);
