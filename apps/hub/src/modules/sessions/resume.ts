import type { HubContext } from '../../context';
import { threadKey } from '../../core/ids';
import { releaseAndClose } from './liveness';
import type { OrphanDecisions } from './orphans';
import { reclaimReleased } from './ownership';
import type { SessionsRepo } from './sessions.repo';

/**
 * The first conversation id a session reports resumes that conversation (design §4.2): the
 * agent's latest private asker with the same id (`resumable`: closed private, or away, inactive
 * and not the window) gives back the threads it released that nobody owned since (an away one is
 * closed first, as a conversation runs in one process), and their decision timers stop. Scoped
 * to the agent the NATS caller proved, like `previousSessionId`. Once per session; returns the
 * reclaimed thread ids. DB only.
 */
export function learnClaudeSession(
  ctx: HubContext,
  repo: SessionsRepo,
  orphans: OrphanDecisions,
  s: { agentId: string; sessionId: string; claudeSessionId?: string; at: string },
): number[] {
  const { agentId, sessionId, claudeSessionId, at } = s;
  if (!claudeSessionId || !repo.setClaudeSession(sessionId, claudeSessionId)) return [];
  const match = repo.resumable(agentId, claudeSessionId, sessionId);
  if (!match) return [];
  if (match.liveness === 'away') releaseAndClose(repo, match.id, at);
  // Closing changed its `released`: read it again.
  const closed = repo.get(match.id);
  const reclaimed = closed ? reclaimReleased(repo, closed, sessionId, at) : [];
  if (reclaimed.length === 0) return reclaimed;
  orphans.forget(agentId, reclaimed);
  ctx.logger.info(
    { agent: agentId, session: sessionId, resumed: match.id, reclaimed: reclaimed.map(threadKey) },
    'conversation resumed',
  );
  return reclaimed;
}
