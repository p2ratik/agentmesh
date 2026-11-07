import { homedir } from 'node:os';
import { VERSION } from '@agentmesh/common/version';
import { MESH_WINDOW_ENV, readMarker } from '@agentmesh/common/window';
import { decide } from './guard/decide';
import { guardEvent } from './guard/event';
import { hookOutput, readAll } from './guard/io';
import { forwardReader } from './guard/send';
import { pullStateDirs } from './pull/state';
import { leaveEvent } from './telemetry/events-file';
import { writeGuardStamp } from './window/guard-stamp';

/**
 * The worktree guard, the plugin's PreToolUse hook (dist/guard.js). It runs in every session but
 * acts only in the mesh window: there it denies (exit 2) or asks, and writes the liveness stamp on
 * the activate call; anywhere else it reads stdin for at most a second and exits 0, whatever
 * happens, because `onFailure: "block"` would turn a failure into a blocked edit. Node built-ins
 * only: it runs before every edit, shell call and subagent. In the mesh window each deny and ask,
 * and each pointer it lets through, leaves a timeline event (codes and ids only) after the decision
 * is out; writing it never throws and never changes the decision.
 */

const UNMARKED_STDIN_MS = 1000;
const FAILED = 'mesh window: the guard failed on this call, so it is refused';

/** The parsed call, kept for the failure's event; null until it is read. */
let input: unknown = null;

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
  // The window's data folder (MeshWindowContext.dataDir): activate reads the stamp there and the
  // window writes its forward records there. pullStateDirs always lists one.
  const dir = pullStateDirs(env, home)[0] ?? '.';
  const forwards = forwardReader(dir);
  input = parse(text);
  const decision = decide(input, { marked, policy, home, platform, forwards });
  // The stamp carries this guard's version: the window relays only behind a SendMessage-aware one.
  if (decision.kind === 'stamp') writeGuardStamp(dir, new Date(), VERSION);
  const out = hookOutput(decision);
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  leaveEvent('guard', null, () => guardEvent(input, decision));
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
    const failed = { kind: 'deny', reason: FAILED, code: 'guard.error' } as const;
    if (marked) leaveEvent('guard', null, () => guardEvent(input, failed));
  },
);
