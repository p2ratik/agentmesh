import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readMarker, windowFiles } from '@agentmesh/common/window';
import { promptContext } from './hook/prompt';
import { announce, isStateFile, pullStateDirs, selectStates } from './pull/state';
import { isLocalSessionFile, ownLocalSession } from './relay/local-session';
import { anyFresh, isHeartbeatFile, windowAddresses } from './window/heartbeat';
import { sessionStartOutput } from './window/session-start';

/**
 * The plugin's UserPromptSubmit / SessionStart hook (dist/hook.js, ADR 0008):
 * when a pull-only session in this project has unread mesh work, it adds one line
 * of context saying so. A private session that used the mesh gets its reply note, or
 * on a cross-session turn a label saying whether it is a verified pointer from its
 * mesh window. It prints nothing otherwise, never fails the prompt and always exits
 * 0. Node built-ins only: it runs on every prompt.
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

/** UserPromptSubmit: a private session's reply note, or the label of a cross-session turn. */
function promptLine(prompt: unknown, dirs: readonly string[]): string | null {
  const env = process.env;
  const marked = !!env.AGENTMESH_MESH_WINDOW;
  const now = Date.now();
  const read = (filter: (name: string) => boolean) => dirs.flatMap((d) => readJsonFiles(d, filter));
  const pid = Number(env.CLAUDE_PID);
  const own = marked ? null : ownLocalSession(read(isLocalSessionFile), pid, now);
  const addresses = own ? windowAddresses(read(isHeartbeatFile), own.prefix, own.agentId, now) : [];
  return promptContext({ prompt, marked, own, windowAddresses: addresses });
}

async function main(): Promise<void> {
  type Input = { hook_event_name?: unknown; source?: unknown; prompt?: unknown };
  const input = parse(await readStdin()) as Input | null;
  const event = input?.hook_event_name;
  if (typeof event !== 'string' || !EVENTS.has(event)) return;
  const dirs = pullStateDirs(process.env, homedir());
  const values = dirs.flatMap((d) => readJsonFiles(d, isStateFile));
  const states = selectStates(
    values,
    process.env.CLAUDE_PROJECT_DIR,
    Date.now(),
    process.platform === 'win32',
  );
  const pull = announce(states);
  if (event !== 'SessionStart') {
    const context = [pull, promptLine(input?.prompt, dirs)].filter(Boolean).join('\n');
    if (context) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: event, additionalContext: context },
        }),
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
