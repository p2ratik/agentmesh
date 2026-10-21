import { internalId, threadKey } from '../../core/ids';
import { fromJson } from '../../db/database';
import type { ClaimTarget } from './claims';
import type { SessionRow, SessionsRepo } from './sessions.repo';

/** Ownership rules over the repo (spec §3, "Ownership is sticky"). DB only. */

export interface ClaimResolvers {
  locate(taskId: number): { threadId: number } | null;
  threadOf(planId: number): number | null;
}

/** The thread a claim is about: tasks and plans through their own threads. */
export function claimedThread(target: ClaimTarget, resolve: ClaimResolvers): number | null {
  switch (target.kind) {
    case 'thread':
      return internalId('thread', target.key);
    case 'task':
      return resolve.locate(internalId('task', target.key))?.threadId ?? null;
    case 'plan':
      return resolve.threadOf(internalId('plan', target.key));
  }
}

/**
 * The first acting session owns the thread. An open owner keeps it and the
 * caller gets a note saying where the messages go; a closed owner's hold lapses.
 */
export function claimThread(
  repo: SessionsRepo,
  claim: { agentId: string; sessionId: string; threadId: number; at: string },
): string | null {
  const { agentId, sessionId, threadId, at } = claim;
  const owner = repo.owner(threadId, agentId);
  if (owner === sessionId) return null;
  const held = owner ? repo.get(owner) : undefined;
  if (!held || held.liveness === 'closed') {
    repo.setOwner(threadId, agentId, sessionId, at);
    return null;
  }
  const key = threadKey(threadId);
  return (
    `${key} belongs to your session ${held.id} (“${held.description ?? 'no description'}”); ` +
    `its messages go there. Run /agentmesh:take ${key} to move it here.`
  );
}

/** The closed session's released threads that are still unowned move to `sessionId`. */
export function reclaimReleased(
  repo: SessionsRepo,
  closed: SessionRow,
  sessionId: string,
  at: string,
): number[] {
  const free = fromJson<number[]>(closed.released, []).filter(
    (threadId) => repo.owner(threadId, closed.agent_id) === null,
  );
  for (const threadId of free) repo.setOwner(threadId, closed.agent_id, sessionId, at);
  return free;
}
