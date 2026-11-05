import { newSessionId } from '@agentmesh/common';
import type { HubContext } from '../../context';
import type { OpenInput } from '../../contracts';
import { evictStalest } from './liveness';
import { reclaimReleased } from './ownership';
import type { SessionsRepo } from './sessions.repo';

/**
 * `session.hello`: reuses this process's open previous session; after a closed one, a new session
 * reclaims what nobody took since. Returns the session's id and the reclaimed thread ids.
 */
export function openSession(
  ctx: HubContext,
  repo: SessionsRepo,
  agentId: string,
  input: OpenInput,
): { sessionId: string; reclaimed: number[] } {
  const at = ctx.clock.now().toISOString();
  const git = { repo: input.repo ?? null, branch: input.branch ?? null };
  const result = ctx.db.transaction(() => {
    const previous = input.previousSessionId ? repo.get(input.previousSessionId) : undefined;
    const mine = previous?.agent_id === agentId ? previous : undefined;
    if (mine && mine.liveness !== 'closed') {
      repo.touch(mine.id, at, git);
      // A window started before the hub upgrade (migration 007) says so on its next hello.
      if (input.meshWindow) repo.markMeshWindow(mine.id);
      if (repo.markLive(mine.id)) ctx.outbox.kick();
      return { sessionId: mine.id, reclaimed: [] as number[], evicted: 0 };
    }
    const id = newSessionId();
    const evicted = evictStalest(ctx, repo, agentId, at);
    const { clientVersion, meshWindow } = input;
    repo.insert({ id, agentId, clientVersion, meshWindow, ...git, at });
    const reclaimed = mine ? reclaimReleased(repo, mine, id, at) : [];
    return { sessionId: id, reclaimed, evicted };
  });
  const { sessionId, reclaimed, evicted } = result;
  ctx.logger.info(
    { agent: agentId, session: sessionId, reclaimed: reclaimed.length, evicted },
    'session opened',
  );
  // What the closed sessions owned goes elsewhere now.
  if (evicted) ctx.outbox.kick();
  return { sessionId, reclaimed };
}
