import { newSessionId } from '@agentmesh/common';
import type { HubContext } from '../../context';
import type { OpenInput } from '../../contracts';
import { recordHub } from '../observe/hub-event';
import { evictStalest } from './liveness';
import type { OrphanDecisions } from './orphans';
import { reclaimReleased } from './ownership';
import { learnClaudeSession } from './resume';
import type { SessionsRepo } from './sessions.repo';

/**
 * `session.hello`: reuses this process's open previous session; after a closed one, a new session
 * reclaims what nobody took since. The first conversation id the session reports takes back what
 * that conversation's closed or away session released (resume.ts). Returns the session's id and
 * the reclaimed thread ids.
 */
export function openSession(
  ctx: HubContext,
  repo: SessionsRepo,
  orphans: OrphanDecisions,
  agentId: string,
  input: OpenInput,
): { sessionId: string; reclaimed: number[] } {
  const at = ctx.clock.now().toISOString();
  const { clientVersion, meshWindow, claudeSessionId } = input;
  const git = { repo: input.repo ?? null, branch: input.branch ?? null };
  const result = ctx.db.transaction(() => {
    const previous = input.previousSessionId ? repo.get(input.previousSessionId) : undefined;
    const mine = previous?.agent_id === agentId ? previous : undefined;
    let sessionId: string;
    let reclaimed: number[] = [];
    let evicted = 0;
    let back = false;
    if (mine && mine.liveness !== 'closed') {
      sessionId = mine.id;
      // A plugin updated in place says so: the relay's version gate reads this row.
      repo.touch(sessionId, at, { ...git, clientVersion });
      // A window started before the hub upgrade (migration 007) says so on its next hello.
      if (meshWindow) repo.markMeshWindow(sessionId);
      back = repo.markLive(sessionId);
    } else {
      sessionId = newSessionId();
      evicted = evictStalest(ctx, repo, agentId, at);
      repo.insert({ id: sessionId, agentId, clientVersion, meshWindow, ...git, at });
      if (mine) reclaimed = reclaimReleased(repo, mine, sessionId, at);
    }
    const s = { agentId, sessionId, claudeSessionId, at };
    reclaimed.push(...learnClaudeSession(ctx, repo, orphans, s));
    return { sessionId, reclaimed, evicted, back, reused: !!mine && mine.liveness !== 'closed' };
  });
  const { sessionId, reclaimed, evicted, back, reused } = result;
  ctx.logger.info(
    { agent: agentId, session: sessionId, reclaimed: reclaimed.length, evicted },
    'session opened',
  );
  recordHub(ctx, agentId, sessionId, { kind: 'session', phase: reused ? 'hello' : 'opened' });
  if (back) recordHub(ctx, agentId, sessionId, { kind: 'session', phase: 'live' });
  // Back from away, or what the closed sessions owned goes elsewhere (or here) now.
  if (back || evicted || reclaimed.length > 0) ctx.outbox.kick();
  return { sessionId, reclaimed };
}
