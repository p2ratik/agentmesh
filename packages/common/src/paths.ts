import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expands a leading `~` to the home directory, so shared setup docs can say `~/.agentmesh/…`. */
export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home;
  return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;
}
