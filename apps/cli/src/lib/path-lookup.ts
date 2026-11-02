import { statSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

export const isRegularFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Finds an executable on PATH. Relative PATH entries are skipped, so it never looks in the
 * current folder (cmd and `where` do, which would run a planted claude.cmd).
 */
export function findOnPath(
  name: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  isFile: (p: string) => boolean,
): string | null {
  const win = platform === 'win32';
  const exts = win
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [''];
  for (const dir of pathDirs(env.PATH ?? '', win)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** The absolute entries of a PATH value. */
function pathDirs(path: string, win: boolean): string[] {
  const absolute = win ? win32.isAbsolute : posix.isAbsolute;
  return path
    .split(win ? ';' : ':')
    .map((d) => (win ? d.trim().replace(/^"(.*)"$/, '$1') : d))
    .filter((d) => d !== '' && absolute(d));
}
