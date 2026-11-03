import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { isOurShim } from '../render/window';
import { writeFileAtomic } from './files';

/** `to` relative to `from`; without case on Windows and macOS. */
function relativeTo(from: string, to: string, platform: NodeJS.Platform): string {
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  return (platform === 'win32' ? win32 : posix).relative(fold(from), fold(to));
}

/** Whether `dir` is strictly below `home`. */
export function isBelow(dir: string, home: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const rel = relativeTo(home, dir, platform);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  relativeTo(a, b, platform) === '';

const ours = (p: string): boolean => {
  try {
    return isOurShim(readFileSync(p, 'utf8'));
  } catch {
    return false; // a folder or an unreadable file is not ours either
  }
};

export interface ShimPlace {
  dir: string;
  /** `claude-mesh` files beside `claude` that `window init` didn't write and left alone. */
  foreign: string[];
}

/**
 * Writes the `claude-mesh` scripts beside `claude`, whose folder is on PATH already, when that
 * folder is below the home folder, holds no `claude-mesh` file we didn't write, and takes the
 * write. Otherwise into `fallbackDir`, for the human to add to PATH. Never edits PATH.
 */
export function installShim(
  scripts: { name: string; content: string }[],
  i: { claude: string; home: string; fallbackDir: string; platform: NodeJS.Platform },
): ShimPlace {
  const write = (dir: string) => {
    for (const s of scripts) writeFileAtomic(join(dir, s.name), s.content, 0o755);
  };
  const dir = dirname(i.claude);
  const below = isBelow(dir, i.home, i.platform);
  const foreign = below
    ? scripts.map((s) => join(dir, s.name)).filter((p) => existsSync(p) && !ours(p))
    : [];
  if (below && foreign.length === 0) {
    try {
      write(dir);
      return { dir, foreign };
    } catch {
      // that folder takes no write (permissions, a read-only file): use the fallback
    }
  }
  mkdirSync(i.fallbackDir, { recursive: true, mode: 0o700 });
  write(i.fallbackDir);
  return { dir: i.fallbackDir, foreign };
}
