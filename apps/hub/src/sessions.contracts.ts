/** The sessions module's contract (re-exported from `contracts.ts`). */
import type { RpcMethodName, SessionSummary, SessionView } from '@agentmesh/protocol';
import type { CallContext } from './contracts';

export interface SessionRecord {
  id: string;
  agentId: string;
  active: boolean;
  liveness: 'live' | 'away' | 'closed';
  description: string | null;
  repo: string | null;
  branch: string | null;
  createdAt: string;
  activatedAt: string | null;
  lastSeen: string;
}

/** One Claude Code session per plugin process; each thread is owned per agent by one session. */
export interface SessionsService {
  open(
    agentId: string,
    input: { clientVersion: string; repo?: string; branch?: string; previousSessionId?: string },
  ): { session: SessionRecord; reclaimed: number[] };
  /** The agent's non-closed session, else not_found "Unknown or closed session <id>; reconnect". */
  verify(agentId: string, sessionId: string): SessionRecord;
  activate(agentId: string, sessionId: string, description: string): SessionRecord;
  /** Keeps ownership: an inactive owner holds its work. */
  deactivate(agentId: string, sessionId: string): SessionRecord;
  describe(agentId: string, sessionId: string, description: string): SessionRecord;
  /** session.bye: releases ownership and records it for a reconnect to reclaim. */
  close(agentId: string, sessionId: string): void;
  /** Heartbeat: an away session comes back live, ownership intact; closed or foreign is unknown. */
  touch(
    agentId: string,
    sessionId: string,
    git?: { repo?: string; branch?: string },
  ): 'ok' | 'unknown';
  /** Marks the session away now (its delivery could not reach it). */
  unreachable(sessionId: string): void;
  /** Tick: silent live sessions go away; away ones past the grace period close and release. */
  expire(now: Date): { away: number; closed: number };
  take(agentId: string, sessionId: string, threadId: number): { previous: string | null };
  /** After a successful RPC: the calling session owns what it acted on, unless another does. */
  recordClaims(call: CallContext, method: RpcMethodName, params: unknown, result: unknown): void;
  view(sessionId: string): SessionView;
  activeSessions(agentId: string): SessionSummary[];
  hasLiveSession(agentId: string): boolean;
  ownerOf(threadId: number, agentId: string): string | null;
}
