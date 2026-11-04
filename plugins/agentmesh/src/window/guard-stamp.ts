// Built-ins only: dist/guard.js writes the stamp, and the MCP server's activate reads it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFresh } from '../pull/state';

/** Written by the worktree guard on the activate call, in the plugin's data folder. */
export const GUARD_STAMP = 'guard-alive.json';
export const GUARD_STAMP_MAX_AGE_MS = 120_000;

/** Stamps the time and the guard's version (the window relays only behind a 0.6.0 guard). */
export function writeGuardStamp(dir: string, now: Date, version: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, GUARD_STAMP);
  // Write then rename, so activate never reads half a file; per process, so two never collide.
  const staged = `${file}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify({ at: now.toISOString(), version }), { mode: 0o600 });
  renameSync(staged, file);
}

/** The stamp's fields, or none for a missing or corrupt file. */
function readStamp(dir: string): { at?: unknown; version?: unknown } {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, GUARD_STAMP), 'utf8'));
    return typeof value === 'object' && value !== null ? value : {};
  } catch {
    return {};
  }
}

/** Whether the guard wrote its stamp in the last two minutes (and not in the future). */
export function guardAlive(dir: string, now: number): boolean {
  return isFresh(readStamp(dir).at, now, GUARD_STAMP_MAX_AGE_MS);
}

/** The version of a fresh stamp; null for a missing, stale or version-less one (before 0.6.0). */
export function guardVersion(dir: string, now: number): string | null {
  const { at, version } = readStamp(dir);
  return isFresh(at, now, GUARD_STAMP_MAX_AGE_MS) && typeof version === 'string' ? version : null;
}
