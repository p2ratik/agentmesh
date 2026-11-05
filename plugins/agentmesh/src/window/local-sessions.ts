// The server bundle's (task_get in the mesh window): reads files and never spawns.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshLocalSessions, isLocalSessionFile } from '../relay/local-session';
import { originRepo, repoKey } from './checkouts';

/** Every `sess-*` record in the data folder, parsed; a missing folder or a bad file is skipped. */
function records(dir: string): unknown[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter(isLocalSessionFile);
  } catch {
    return [];
  }
  return names.map((name) => {
    try {
      return JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      return null;
    }
  });
}

/**
 * How many of this agent's private sessions (fresh records, Task 5) work in `repo`, a worktree
 * of it included, and how many have unread mesh replies. A count and a status, never paths:
 * the window tells its human and never messages them.
 */
export function localSessionsLine(
  repo: string,
  deps: { dataDir: string; prefix: string; agentId: string; now: number },
): string {
  const want = repoKey(repo);
  const mine = freshLocalSessions(records(deps.dataDir), deps.now).filter(
    (s) =>
      s.prefix === deps.prefix &&
      s.agentId === deps.agentId &&
      originRepo(s.projectDir, true)?.toLowerCase() === want,
  );
  if (mine.length === 0) return 'local sessions: none of your sessions are in this repo.';
  const unread = mine.filter((s) => s.threads > 0).length;
  return `local sessions: ${mine.length} of your sessions are in this repo (${unread} with unread mesh replies); tell your human, never message them.`;
}
