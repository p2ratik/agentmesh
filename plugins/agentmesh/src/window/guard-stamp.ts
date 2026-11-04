// Built-ins only: dist/guard.js writes the stamp, and the MCP server's activate reads it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFresh } from '../pull/state';

/** Written by the worktree guard on the activate call, in the plugin's data folder. */
export const GUARD_STAMP = 'guard-alive.json';
export const GUARD_STAMP_MAX_AGE_MS = 120_000;

export function writeGuardStamp(dir: string, now: Date): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, GUARD_STAMP);
  // Write then rename, so activate never reads half a file; per process, so two never collide.
  const staged = `${file}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify({ at: now.toISOString() }), { mode: 0o600 });
  renameSync(staged, file);
}

/** Whether the guard wrote its stamp in the last two minutes (and not in the future). */
export function guardAlive(dir: string, now: number): boolean {
  try {
    const at = (JSON.parse(readFileSync(join(dir, GUARD_STAMP), 'utf8')) as { at?: unknown }).at;
    return isFresh(at, now, GUARD_STAMP_MAX_AGE_MS);
  } catch {
    return false;
  }
}
