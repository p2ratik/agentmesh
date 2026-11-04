import { toRouteSession } from './mappers';
import type { RouteInput } from './routing';
import type { SessionsRepo } from './sessions.repo';
import type { SessionsDeps } from './sessions.service';

/** Routing's view of a thread: the agent's open sessions and the owner chain; no sender pick. */
export function routeInput(
  repo: SessionsRepo,
  deps: SessionsDeps,
  agentId: string,
  threadId: number,
  taskId: number | null,
): RouteInput {
  const owner = (id: number | null) => (id === null ? null : repo.owner(id, agentId));
  const task = taskId === null ? null : deps.locate(taskId);
  const threadOwner = owner(threadId);
  // Only an unowned thread whose latest releaser closed private had an asker that's gone.
  const by = threadOwner === null ? repo.releasedBy(agentId, threadId) : undefined;
  return {
    sessions: repo.listLive(agentId).map(toRouteSession),
    threadOwner,
    parentOwner: owner(deps.messaging.thread(threadId).parentId),
    taskOwner: task && task.threadId !== threadId ? owner(task.threadId) : null,
    picked: null,
    repo: task?.repo ?? null,
    released:
      by?.private_at_close === 1
        ? { bySession: by.id, closedAt: by.closed_at, claudeSessionId: by.claude_session_id }
        : null,
  };
}
