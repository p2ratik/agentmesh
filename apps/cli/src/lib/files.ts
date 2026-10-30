import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Writes a file readable only by its owner (best effort on Windows). */
export function writePrivateFile(path: string, content: string, overwrite: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some filesystems (Windows, network mounts) do not support POSIX modes.
  }
}

/**
 * Replaces a file via a temp file + rename, so a crash never leaves it half-written.
 * With `mode`, the new file gets that mode (best effort, like `writePrivateFile`).
 */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode });
    if (mode !== undefined) {
      try {
        chmodSync(temp, mode);
      } catch {
        // Some filesystems (Windows, network mounts) do not support POSIX modes.
      }
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Creates parent directories, then writes. */
export function writeFileWithDirs(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
