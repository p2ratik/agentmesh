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
import { pullStateDirs } from '../pull/state';

/**
 * The guard and hook run as short processes, so they leave their timeline events in
 * `events-<pid>.jsonl` in the plugin data folder; the MCP server collects them (and validates
 * them with zod) on its next ship. Node built-ins only: both bundles start on every call.
 */

/** Past this a process's file takes no more events. */
export const MAX_EVENTS_FILE_BYTES = 256 * 1024;

const EVENTS_FILE = /^events-\d+\.jsonl$/;

/** Appends one JSON line; never throws, so a guard's decision never depends on it. */
export function appendEvent(dataDir: string, event: object): void {
  try {
    const file = join(dataDir, `events-${process.pid}.jsonl`);
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= MAX_EVENTS_FILE_BYTES) return;
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // An event lost is better than a guard that fails.
  }
}

/**
 * The guard's or hook's event, stamped with an id, the time and its source, left in the plugin
 * data folder both already use (MeshWindowContext.dataDir). Nothing without fields or a folder.
 * `fields` is built inside the try too: this never throws, so a guard's decision and a hook's
 * output never depend on it.
 */
export function leaveEvent(
  source: 'guard' | 'hook',
  session: string | null,
  fields: () => object | null,
): void {
  try {
    const dir = pullStateDirs(process.env, homedir())[0];
    const event = dir ? fields() : null;
    if (!dir || !event) return;
    appendEvent(dir, { id: randomUUID(), at: new Date().toISOString(), session, source, ...event });
  } catch {
    // As above: the event is lost, nothing else.
  }
}

/**
 * Reads every events file and deletes it, returning its lines parsed (null for a bad line).
 * A file that can't be read or deleted (still being written, on Windows) waits for the next call.
 */
export function collectEventFiles(dataDir: string): unknown[] {
  let names: string[];
  try {
    names = readdirSync(dataDir).filter((name) => EVENTS_FILE.test(name));
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
