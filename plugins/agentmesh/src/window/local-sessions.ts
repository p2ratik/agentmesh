// The server bundle's (task_get in the mesh window): reads files and never spawns.
import { readLocalSessions } from '../relay/local-session';
import { originRepo, repoKey } from './checkouts';

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
  const mine = readLocalSessions(deps.dataDir, deps.now).filter(
    (s) =>
      s.prefix === deps.prefix &&
      s.agentId === deps.agentId &&
      originRepo(s.projectDir, true)?.toLowerCase() === want,
  );
  if (mine.length === 0) return 'local sessions: none of your sessions are in this repo.';
  const n = mine.length;
  const unread = mine.filter((s) => s.threads > 0).length;
  return `local sessions: ${n} of your sessions ${n === 1 ? 'is' : 'are'} in this repo (${unread} with unread mesh replies); tell your human, never message them.`;
}
