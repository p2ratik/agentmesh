import type { ReleasedMarker } from '@agentmesh/protocol';
import { toRouteSession } from './mappers';
import { chainOwner, type RouteInput, takesReleased } from './routing';
import type { SessionsRepo } from './sessions.repo';
import type { SessionsDeps } from './sessions.service';

/**
 * Routing's view of a thread: the agent's open sessions and the owner chain; no sender pick and
 * no `released` marker (`releasedMarker` adds it when routing a delivery).
 */
export function routeInput(
  repo: SessionsRepo,
  deps: SessionsDeps,
  agentId: string,
  threadId: number,
  taskId: number | null,
): RouteInput {
  const owner = (id: number | null) => (id === null ? null : repo.owner(id, agentId));
  const task = taskId === null ? null : deps.locate(taskId);
  return {
    sessions: repo.listLive(agentId).map(toRouteSession),
    threadOwner: owner(threadId),
    parentOwner: owner(deps.messaging.thread(threadId).parentId),
    taskOwner: task && task.threadId !== threadId ? owner(task.threadId) : null,
    picked: null,
    repo: task?.repo ?? null,
    released: null,
  };
}

/** Only an unowned thread whose latest releaser closed private had an asker that's gone. */
export function releasedMarker(
  repo: SessionsRepo,
  agentId: string,
  threadId: number,
  threadOwner: string | null,
): ReleasedMarker | null {
  const by = threadOwner === null ? repo.releasedBy(agentId, threadId) : undefined;
  if (by?.private_at_close !== 1) return null;
  return { bySession: by.id, closedAt: by.closed_at, claudeSessionId: by.claude_session_id };
}

/**
 * The marker a read of the thread by `sessionId` shows, as its push carries it: only for an
 * active 0.6.0 mesh window (push or pull), and only while no session holds the thread.
 */
export function releasedForRead(
  repo: SessionsRepo,
  deps: SessionsDeps,
  agentId: string,
  sessionId: string,
  threadId: number,
): ReleasedMarker | null {
  const input = routeInput(repo, deps, agentId, threadId, deps.messaging.thread(threadId).taskId);
  const self = input.sessions.find((s) => s.id === sessionId);
  if (!self?.active || !takesReleased(self) || chainOwner(input)) return null;
  return releasedMarker(repo, agentId, threadId, input.threadOwner);
}
