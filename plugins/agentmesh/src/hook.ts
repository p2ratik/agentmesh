import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hookAgentId } from './agent-id';
import { type PromptLine, promptContext, unreadInput } from './hook/prompt';
import { announce, isStateFile, pullStateDirs, readJsonFiles, selectStates } from './pull/state';
import { type LocalSession, ownLocalSession, readLocalSessions } from './relay/local-session';
import {
  deleteClaudeSession,
  pruneClaudeSessions,
  writeClaudeSession,
} from './resume/claude-session';
import { leaveEvent } from './telemetry/events-file';
import { anyFresh, isHeartbeatFile, windowAddresses } from './window/heartbeat';
import { sessionStartOutput } from './window/session-start';
import { windowStartState } from './window/start-state';

/**
 * The plugin's UserPromptSubmit / SessionStart / SessionEnd hook (dist/hook.js, ADR 0008):
 * when a pull-only session in this project has unread mesh work, it adds one line
 * of context saying so. A private session that used the mesh gets its reply note, or
 * on a cross-session turn a label saying whether it is a verified pointer from its
 * mesh window. Session start records the conversation id for the MCP server and session
 * end deletes it. It prints nothing otherwise, never fails the prompt and always exits
 * 0. Each note or label it adds leaves a timeline event (the note and a count, never the
 * prompt). Node built-ins only: it runs on every prompt.
 */

const EVENTS = new Set(['UserPromptSubmit', 'SessionStart', 'SessionEnd']);
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

/** SessionStart: the window's rules, or a one-time hint that nothing is listening. */
function sessionStart(source: unknown): {
  additionalContext: string | null;
  systemMessage: string | null;
} {
  const env = process.env;
  const home = homedir();
  const { policy, setUp } = windowStartState(env, hookAgentId(env, home), home, process.platform);
  const dir = pullStateDirs(env, home)[0];
  return sessionStartOutput({
    source: typeof source === 'string' ? source : undefined,
    marked: !!env.AGENTMESH_MESH_WINDOW,
    policy,
    enrolled:
      existsSync(join(home, '.agentmesh', 'agent.json')) || !!env.CLAUDE_PLUGIN_OPTION_AGENT_ID,
    hintOff: env.AGENTMESH_MESH_WINDOW_HINT === 'off',
    listening: !!dir && anyFresh(readJsonFiles(dir, isHeartbeatFile), Date.now()),
    setUp,
  });
}

/** This private session's own fresh record (matched by `CLAUDE_PID`), if it used the mesh. */
function ownSession(dirs: readonly string[], now: number): LocalSession | null {
  const sessions = dirs.flatMap((d) => readLocalSessions(d, now));
  return ownLocalSession(sessions, Number(process.env.CLAUDE_PID), now);
}

/** A line for this prompt, and the hub session of the private session it is for, if known. */
type Added = { line: PromptLine; session: string | null };

const added = (line: PromptLine | null, own: LocalSession | null): Added | null =>
  line && { line, session: own?.hubSessionId ?? null };

/**
 * An input cut at MAX_STDIN or the wait, or not JSON: a sender controls a cross-session turn's
 * length, so the mesh window, and a private session that used the mesh, still get their label.
 */
function unreadLine(text: string, dirs: readonly string[]): Added | null {
  const marked = !!process.env.AGENTMESH_MESH_WINDOW;
  const own = marked ? null : ownSession(dirs, Date.now());
  return added(unreadInput(text, marked, own !== null), own);
}

/** UserPromptSubmit: a private session's reply note, or the label of a cross-session turn. */
function promptLine(prompt: unknown, dirs: readonly string[]): Added | null {
  const marked = !!process.env.AGENTMESH_MESH_WINDOW;
  const now = Date.now();
  const own = marked ? null : ownSession(dirs, now);
  const beats = own ? dirs.flatMap((d) => readJsonFiles(d, isHeartbeatFile)) : [];
  const addresses = own ? windowAddresses(beats, own.prefix, own.agentId, now) : [];
  return added(promptContext({ prompt, marked, own, windowAddresses: addresses }), own);
}

/** The conversation id by `CLAUDE_PID`, for this process's MCP server (resume); best effort. */
function recordConversation(event: string, dir: string, input: Input | null): void {
  const pid = process.env.CLAUDE_PID;
  try {
    if (event === 'SessionEnd') {
      deleteClaudeSession(dir, pid, input?.session_id);
      return;
    }
    pruneClaudeSessions(dir, Date.now());
    writeClaudeSession(
      dir,
      pid,
      { session_id: input?.session_id, source: input?.source },
      new Date(),
    );
  } catch {
    // A full disk or a locked folder must not cost the session its start-up context.
  }
}

type Input = {
  hook_event_name?: unknown;
  source?: unknown;
  prompt?: unknown;
  session_id?: unknown;
};

/** UserPromptSubmit's output, then the line's timeline event (its note and count only). */
function prompted(event: string, pull: string | null, line: Added | null): void {
  const context = [pull, line?.line.text].filter(Boolean).join('\n');
  if (context) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: context },
      }),
    );
  }
  if (!line) return;
  const { note, unread } = line.line;
  leaveEvent('hook', line.session, () => ({ kind: 'hook', note, unread }));
}

async function main(): Promise<void> {
  const text = await readStdin();
  const input = parse(text) as Input | null;
  const dirs = pullStateDirs(process.env, homedir());
  const unread = input === null ? unreadLine(text, dirs) : null;
  const event = unread ? 'UserPromptSubmit' : input?.hook_event_name;
  if (typeof event !== 'string' || !EVENTS.has(event)) return;
  const [dir] = dirs;
  if (event !== 'UserPromptSubmit' && dir) recordConversation(event, dir, input);
  if (event === 'SessionEnd') return;
  const values = dirs.flatMap((d) => readJsonFiles(d, isStateFile));
  const states = selectStates(
    values,
    process.env.CLAUDE_PROJECT_DIR,
    Date.now(),
    process.platform === 'win32',
  );
  const pull = announce(states);
  if (event !== 'SessionStart') {
    prompted(event, pull, unread ?? promptLine(input?.prompt, dirs));
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
  .catch(() => leaveEvent('hook', null, () => ({ kind: 'hook', note: 'error' })))
  .finally(() => {
    process.exitCode = 0;
  });
