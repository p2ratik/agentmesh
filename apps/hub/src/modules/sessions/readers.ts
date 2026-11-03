import { MeshError } from '@agentmesh/common';
import type { SessionsService, ThreadOwner } from '../../contracts';

/**
 * May this session take unowned work? Only an active, live-or-away (never closed)
 * session may; a pull session only while no push session of the agent is ready.
 * Unknown or closed sessions answer false rather than throwing.
 */
export function takeUnownedReader(
  sessions: () => SessionsService | null | undefined,
): (agentId: string, sessionId: string) => boolean {
  return (agentId, sessionId) => {
    const service = sessions();
    if (!service) return false;
    try {
      const s = service.verify(agentId, sessionId);
      if (s.liveness === 'closed' || !s.active) return false;
      return s.delivery === 'push' || !service.hasReadySession(agentId);
    } catch (err) {
      if (err instanceof MeshError && err.code === 'not_found') return false;
      throw err;
    }
  };
}

/** The thread owner as messaging sees it: the effective owner session and whether it is away. */
export function ownerReader(
  sessions: SessionsService,
): (threadId: number, agentId: string) => ThreadOwner | null {
  return (threadId, agentId) => {
    const sessionId = sessions.effectiveOwner(threadId, agentId);
    if (sessionId === null) return null;
    // Owners are never closed: closing a session releases what it owns.
    const away = sessions.verify(agentId, sessionId).liveness === 'away';
    return { sessionId, liveness: away ? 'away' : 'live' };
  };
}
