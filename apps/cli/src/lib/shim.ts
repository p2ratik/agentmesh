import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { isOurShim } from '../render/window';
import { writeFileAtomic } from './files';

/** Whether `dir` is strictly below `home`; without case on Windows and macOS. */
export function isBelow(dir: string, home: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const rel = path.relative(fold(home), fold(dir));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

const ours = (p: string): boolean => {
  try {
    return isOurShim(readFileSync(p, 'utf8'));
  } catch {
    return false; // a folder or an unreadable file is not ours either
  }
};

export interface ShimPlace {
  dir: string;
  fallback: boolean;
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
      return { dir, fallback: false, foreign };
    } catch {
      // that folder takes no write (permissions, a read-only file): use the fallback
    }
  }
  mkdirSync(i.fallbackDir, { recursive: true, mode: 0o700 });
  write(i.fallbackDir);
  return { dir: i.fallbackDir, fallback: true, foreign };
}
