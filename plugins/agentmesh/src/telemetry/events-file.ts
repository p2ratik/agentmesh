import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hookAgentId } from '../agent-id';
import { PARTICIPANT_ID, pullStateDirs } from '../pull/state';

/**
 * The guard and hook run as short processes, so they leave their timeline events in
 * `events-<agent>-<pid>.jsonl` in the plugin data folder, or `events-<pid>.jsonl` when the writer
 * doesn't know its agent (only in CLAUDE_PLUGIN_DATA, which is this plugin's alone). The MCP
 * server collects its own agent's files (and validates them with zod) on its next ship. Node
 * built-ins only: both bundles start on every call.
 */

/** Past this a process's file takes no more events. */
export const MAX_EVENTS_FILE_BYTES = 256 * 1024;
/** Past this many waiting files no process starts another: nobody is collecting them. It matches
 * `client.maxBufferedEvents`, all the recorder could keep anyway. */
export const MAX_EVENT_FILES = 500;

const EVENTS_FILE = /^events-(?:[a-z0-9][a-z0-9-]{0,62}-)?\d+\.jsonl$/;
const UNNAMED = /^events-\d+\.jsonl$/;
const PID_FILE = /^\d+\.jsonl$/;

/** How many events files wait in `dir`, of any agent: one listing, before a process's first line. */
function waiting(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => EVENTS_FILE.test(name)).length;
  } catch {
    return 0;
  }
}

/**
 * Appends one JSON line to this process's file, named by `agent` when it is a participant id.
 * Never throws, so a guard's decision never depends on it.
 */
export function appendEvent(dataDir: string, event: object, agent: string | null = null): void {
  try {
    if (agent !== null && !PARTICIPANT_ID.test(agent)) return;
    const name = agent === null ? `${process.pid}` : `${agent}-${process.pid}`;
    const file = join(dataDir, `events-${name}.jsonl`);
    const size = statSync(file, { throwIfNoEntry: false })?.size;
    if (size === undefined ? waiting(dataDir) >= MAX_EVENT_FILES : size >= MAX_EVENTS_FILE_BYTES) {
      return;
    }
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // An event lost is better than a guard that fails.
  }
}

/**
 * The guard's or hook's event, stamped with an id, the time and its source, left in the plugin
 * data folder both already use (MeshWindowContext.dataDir) and named by the agent the hook
 * resolves (agent-id.ts). An unnamed file is left only in CLAUDE_PLUGIN_DATA: in the shared
 * fallback no shipper would take it. `fields` is built inside the try too: this never throws, so a
 * guard's decision and a hook's output never depend on it.
 */
export function leaveEvent(
  source: 'guard' | 'hook',
  session: string | null,
  fields: () => object | null,
): void {
  try {
    const event = fields();
    if (!event) return;
    const env = process.env;
    const home = homedir();
    const dir = pullStateDirs(env, home)[0];
    const id = hookAgentId(env, home);
    const agent = id !== null && PARTICIPANT_ID.test(id) ? id : null;
    if (!dir || (agent === null && !env.CLAUDE_PLUGIN_DATA)) return;
    const stamped = { id: randomUUID(), at: new Date().toISOString(), session, source, ...event };
    appendEvent(dir, stamped, agent);
  } catch {
    // As above: the event is lost, nothing else.
  }
}

/**
 * Reads `agentId`'s events files and deletes them, returning their lines parsed (null for a bad
 * line); with `unnamed` (the folder is CLAUDE_PLUGIN_DATA), the files that name no agent too.
 * Another agent's files stay. A file that can't be read or deleted (still being written, on
 * Windows) waits for the next call.
 */
export function collectEventFiles(dataDir: string, agentId: string, unnamed: boolean): unknown[] {
  const prefix = `events-${agentId}-`;
  const mine = (name: string) =>
    (name.startsWith(prefix) && PID_FILE.test(name.slice(prefix.length))) ||
    (unnamed && UNNAMED.test(name));
  let names: string[];
  try {
    names = readdirSync(dataDir).filter(mine);
  } catch {
    return [];
  }
  const values: unknown[] = [];
  for (const name of names) {
    try {
      const file = join(dataDir, name);
      const text = readFileSync(file, 'utf8');
      // ponytail: a line appended between read and unlink is lost; per-pid files make it rare.
      unlinkSync(file);
      for (const line of text.split('\n')) if (line) values.push(parseLine(line));
    } catch {
      // Next time.
    }
  }
  return values;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
