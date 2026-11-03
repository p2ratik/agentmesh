import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { isOurShim } from '../render/window';
import { writeFileAtomic } from './files';

/**
 * Whether `dir` is strictly below `home`, without case on Windows and macOS. Never when home is a
 * filesystem root (`/`, `C:\`): every folder would be below it.
 */
export function isBelow(dir: string, home: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  if (path.dirname(fold(home)) === fold(home)) return false;
  const rel = path.relative(fold(home), fold(dir));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Whether the file at `p` carries the `claude-mesh` marker line. */
export const isOwnShim = (p: string): boolean => {
  try {
    return isOurShim(readFileSync(p, 'utf8'));
  } catch {
    return false; // a folder or an unreadable file is not ours either
  }
};

/** Whether `p` holds something we must not replace: anything but a regular file of ours. */
function foreignAt(p: string): boolean {
  try {
    return !lstatSync(p).isFile() || !isOwnShim(p);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'; // nothing there is fine
  }
}

const realPath = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

export interface ShimPlace {
  dir: string;
  /** `claude-mesh` files beside `claude` that `window init` didn't write and left alone. */
  foreign: string[];
}

/**
 * Writes the `claude-mesh` scripts beside `claude`, whose folder is on PATH already, when that
 * folder is really below the home folder (links resolved), holds nothing named `claude-mesh` but
 * files we wrote, and takes the write. Otherwise into `fallbackDir`, for the human to add to PATH.
 * Never edits PATH.
 */
export function installShim(
  scripts: { name: string; content: string }[],
  i: { claude: string; home: string; fallbackDir: string; platform: NodeJS.Platform },
): ShimPlace {
  const write = (dir: string) => {
    for (const s of scripts) writeFileAtomic(join(dir, s.name), s.content, 0o755);
  };
  const dir = dirname(i.claude);
  const [realDir, realHome] = [realPath(dir), realPath(i.home)];
  const below = realDir !== null && realHome !== null && isBelow(realDir, realHome, i.platform);
  const foreign = below ? scripts.map((s) => join(dir, s.name)).filter(foreignAt) : [];
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
