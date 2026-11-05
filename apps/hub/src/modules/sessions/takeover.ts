import type { Logger } from '@agentmesh/common';
import { threadKey } from '../../core/ids';
import { releaseAndClose } from './liveness';
import { reclaimReleased } from './ownership';
import type { SessionRow, SessionsRepo } from './sessions.repo';

export interface Adopted {
  closed: string[];
  reclaimed: number[];
}

/**
 * One mesh window per teammate (ADR 0009): a window that activates closes the agent's other
 * windows that are away (a sleep or crash sends no bye) and takes their threads at once, instead
 * of after the ownership grace. Live windows, private sessions and other agents are never
 * touched. DB only; run inside the activating transaction.
 */
export function adoptAwayWindows(repo: SessionsRepo, window: SessionRow, at: string): Adopted {
  const result: Adopted = { closed: [], reclaimed: [] };
  if (window.mesh_window !== 1) return result;
  const stale = repo
    .listLive(window.agent_id)
    .filter((s) => s.id !== window.id && s.mesh_window === 1 && s.liveness === 'away');
  for (const { id } of stale) {
    releaseAndClose(repo, id, at);
    // Closing changed its `released`: read it again.
    const closed = repo.get(id);
    result.closed.push(id);
    if (closed) result.reclaimed.push(...reclaimReleased(repo, closed, window.id, at));
  }
  return result;
}

export function logAdopted(log: Logger, agent: string, session: string, a: Adopted): void {
  if (a.closed.length === 0) return;
  const info = { agent, session, replaced: a.closed, reclaimed: a.reclaimed.map(threadKey) };
  log.info(info, 'away mesh window replaced');
}
