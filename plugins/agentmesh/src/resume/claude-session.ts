// Built-ins only (the hook bundle imports this).
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Claude Code's conversation id, by process: the SessionStart hook writes `cc-{CLAUDE_PID}.json`
 * ({ session_id, source, at }) in the plugin data folder, SessionEnd deletes it, and the MCP
 * server (a child of that process) reads it by its `process.ppid` to follow its conversation.
 */

/** ClaudeSessionId from @agentmesh/protocol, copied so the hook bundle stays tiny. */
export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The hook and the MCP server start together, so a record written up to this long before the
 * server started is still its own; an older one is a dead process's whose PID Windows reused.
 */
export const CLAUDE_SESSION_SLACK_MS = 60_000;

/** Records left behind by a crash are deleted after this long. */
const RECORD_MAX_AGE_MS = 24 * 3600_000;
const RECORD_FILE = /^cc-\d{1,10}\.json(?:\.tmp)?$/;

/** The record's file name, or null for anything but a process id (checked before any fs call). */
export function claudeSessionFile(pid: unknown): string | null {
  if (typeof pid !== 'string' && typeof pid !== 'number') return null;
  const text = String(pid);
  return /^\d{1,10}$/.test(text) ? `cc-${text}.json` : null;
}

/** Writes the record (then renames it, 0600); nothing for a bad process or conversation id. */
export function writeClaudeSession(
  dir: string,
  pid: unknown,
  input: { session_id: unknown; source: unknown },
  now: Date,
): void {
  const name = claudeSessionFile(pid);
  const id = input.session_id;
  if (!name || typeof id !== 'string' || !CLAUDE_SESSION_ID.test(id)) return;
  const source = typeof input.source === 'string' ? input.source.slice(0, 32) : null;
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify({ session_id: id, source, at: now.toISOString() }), {
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
}

/** A record's parsed contents, or null when it is missing or not JSON. */
function readRecord(file: string): { session_id?: unknown; at?: unknown } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Deletes the record only while it names the conversation that ended: on `/clear`, the old
 * conversation's SessionEnd may run after the new one's SessionStart rewrote it.
 */
export function deleteClaudeSession(dir: string, pid: unknown, sessionId: unknown): void {
  const name = claudeSessionFile(pid);
  if (!name || typeof sessionId !== 'string' || !CLAUDE_SESSION_ID.test(sessionId)) return;
  const file = join(dir, name);
  // ponytail: read, then remove; a SessionStart landing in between is lost (a microsecond window).
  if (readRecord(file)?.session_id === sessionId) rmSync(file, { force: true });
}

/** Best effort: deletes records (and leftover temp files) not written for a day. */
export function pruneClaudeSessions(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => RECORD_FILE.test(name));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > RECORD_MAX_AGE_MS) rmSync(file, { force: true });
    } catch {
      // Another session's hook got there first.
    }
  }
}

/** This process's conversation id, if its record was written since `startedAt` (less the slack). */
export function readClaudeSession(dir: string, ppid: number, startedAt: number): string | null {
  const name = claudeSessionFile(ppid);
  if (!name) return null;
  const value = readRecord(join(dir, name));
  const id = value?.session_id;
  const at = typeof value?.at === 'string' ? Date.parse(value.at) : Number.NaN;
  if (typeof id !== 'string' || !CLAUDE_SESSION_ID.test(id)) return null;
  return at >= startedAt - CLAUDE_SESSION_SLACK_MS ? id : null;
}
