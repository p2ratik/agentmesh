import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { announce, isStateFile, pullStateDirs, selectStates } from './pull/state';

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

/** Every state file in a directory; a missing directory or a bad file is skipped. */
function readStates(dir: string): unknown[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter(isStateFile);
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

async function main(): Promise<void> {
  const input = parse(await readStdin()) as { hook_event_name?: unknown } | null;
  const event = input?.hook_event_name;
  if (typeof event !== 'string' || !EVENTS.has(event)) return;
  const values = pullStateDirs(process.env, homedir()).flatMap(readStates);
  const states = selectStates(
    values,
    process.env.CLAUDE_PROJECT_DIR,
    Date.now(),
    process.platform === 'win32',
  );
  const text = announce(states);
  if (!text) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
  );
}

main()
  .catch(() => undefined)
  .finally(() => {
    process.exitCode = 0;
  });
