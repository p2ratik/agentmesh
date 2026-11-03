import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readMarker, windowFiles } from '@agentmesh/common/window';
import { announce, isStateFile, pullStateDirs, selectStates } from './pull/state';
import { anyFresh, isHeartbeatFile } from './window/heartbeat';
import { sessionStartOutput } from './window/session-start';

/**
 * The plugin's UserPromptSubmit / SessionStart hook (dist/hook.js, ADR 0008):
 * when a pull-only session in this project has unread mesh work, it adds one line
 * of context saying so. It prints nothing otherwise, never fails the prompt and
 * always exits 0. Node built-ins only: it runs on every prompt.
 */

const EVENTS = new Set(['UserPromptSubmit', 'SessionStart']);
const STDIN_WAIT_MS = 1000;
const MAX_STDIN = 1_000_000;

/** Claude Code writes the event as JSON and closes stdin; never wait on it for long. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(done, STDIN_WAIT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_STDIN) done();
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Every matching file in a directory, parsed; a missing directory or a bad file is skipped. */
function readJsonFiles(dir: string, filter: (name: string) => boolean): unknown[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter(filter);
  } catch {
    return [];
  }
  return names.map((name) => {
    try {
      return parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      return null;
    }
  });
}

/** SessionStart: the window's rules, or a one-time hint that nothing is listening. */
function sessionStart(source: unknown): {
  additionalContext: string | null;
  systemMessage: string | null;
} {
  const env = process.env;
  const home = homedir();
  const { policy } = readMarker(env, home, process.platform);
  const dir = pullStateDirs(env, home)[0];
  return sessionStartOutput({
    source: typeof source === 'string' ? source : undefined,
    marked: !!env.AGENTMESH_MESH_WINDOW,
    policy,
    enrolled:
      existsSync(join(home, '.agentmesh', 'agent.json')) || !!env.CLAUDE_PLUGIN_OPTION_AGENT_ID,
    hintOff: env.AGENTMESH_MESH_WINDOW_HINT === 'off',
    listening: !!dir && anyFresh(readJsonFiles(dir, isHeartbeatFile), Date.now()),
    launcherExists: existsSync(windowFiles(home, process.platform).launcher),
  });
}

async function main(): Promise<void> {
  const input = parse(await readStdin()) as { hook_event_name?: unknown; source?: unknown } | null;
  const event = input?.hook_event_name;
  if (typeof event !== 'string' || !EVENTS.has(event)) return;
  const values = pullStateDirs(process.env, homedir()).flatMap((d) =>
    readJsonFiles(d, isStateFile),
  );
  const states = selectStates(
    values,
    process.env.CLAUDE_PROJECT_DIR,
    Date.now(),
    process.platform === 'win32',
  );
  const pull = announce(states);
  if (event !== 'SessionStart') {
    if (pull) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: pull } }),
      );
    }
    return;
  }
  const start = sessionStart(input?.source);
  const context = [pull, start.additionalContext].filter(Boolean).join('\n');
  if (!context && !start.systemMessage) return;
  process.stdout.write(
    JSON.stringify({
      ...(start.systemMessage ? { systemMessage: start.systemMessage } : {}),
      hookSpecificOutput: {
        hookEventName: event,
        ...(context ? { additionalContext: context } : {}),
      },
    }),
  );
}

main()
  .catch(() => undefined)
  .finally(() => {
    process.exitCode = 0;
  });
