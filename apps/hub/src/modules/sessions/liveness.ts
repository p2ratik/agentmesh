import { DAY_MS } from '@agentmesh/common';
import type { HubContext } from '../../context';
import { recordHub } from '../observe/hub-event';
import type { SessionRow, SessionsRepo } from './sessions.repo';

/** Closed sessions are kept this long (a returning process reclaims from its closed one), then deleted. */
const CLOSED_RETENTION_MS = 30 * DAY_MS;

/**
 * Releases the session's threads and closes it; shared by `session.bye` and expiry. A private
 * session (inactive, not the mesh window) is recorded as one: its threads' answers then go to
 * the window as a closed asker's. A window restart or an active session's close is not. An
 * eviction counts too: a live private process it closes may cause one spurious notice before its
 * next hello reclaims its threads. Records `closed` (or `evicted`).
 */
export function releaseAndClose(
  ctx: HubContext,
  repo: SessionsRepo,
  sessionId: string,
  at: string,
  phase: 'closed' | 'evicted' = 'closed',
): number[] {
  const row = repo.get(sessionId);
  const released = repo.releaseOwned(sessionId);
  repo.close(sessionId, at, row?.active === 0 && row.mesh_window === 0);
  if (row) recordHub(ctx, row.agent_id, sessionId, { kind: 'session', phase });
  return released;
}

/** Marks the session away and records it; `expireSessions` and a failed send both come here. */
export function markAwayRecorded(
  ctx: HubContext,
  repo: SessionsRepo,
  sessionId: string,
  at: string,
): void {
  const row = repo.get(sessionId);
  repo.markAway(sessionId, at);
  if (row) recordHub(ctx, row.agent_id, sessionId, { kind: 'session', phase: 'away' });
}

/** A session that was away is live again: records it, and what waited for it goes now. */
export function backLive(ctx: HubContext, agentId: string, sessionId: string): void {
  recordHub(ctx, agentId, sessionId, { kind: 'session', phase: 'live' });
  ctx.outbox.kick();
}

/**
 * Silent live sessions go away (they keep their work); away ones close after
 * `presence.ownershipGraceMinutes`, which releases what they owned. Sessions
 * closed for 30 days are deleted.
 */
export function expireSessions(
  ctx: HubContext,
  repo: SessionsRepo,
  now: Date,
): { away: number; closed: number } {
  const { offlineAfterSeconds, ownershipGraceMinutes } = ctx.loaded.config.presence;
  const at = now.toISOString();
  const staleBefore = new Date(now.getTime() - offlineAfterSeconds * 1000).toISOString();
  const graceBefore = new Date(now.getTime() - ownershipGraceMinutes * 60_000).toISOString();
  const result = ctx.db.transaction(() => {
    const stale = repo.staleLive(staleBefore);
    for (const row of stale) markAwayRecorded(ctx, repo, row.id, at);
    const expired = repo.awayBefore(graceBefore);
    for (const row of expired) releaseAndClose(ctx, repo, row.id, at);
    return { away: stale.length, closed: expired.length };
  });
  if (result.away || result.closed) ctx.logger.info(result, 'sessions expired');
  // Released work goes to another session now, not on the next tick.
  if (result.closed) ctx.outbox.kick();
  const pruned = repo.pruneClosed(new Date(now.getTime() - CLOSED_RETENTION_MS).toISOString());
  if (pruned) ctx.logger.info({ pruned }, 'old closed sessions deleted');
  return result;
}

/** The sessions to close so that `keep` remain: away ones first, then the least recently seen. Pure. */
export function stalest(open: readonly SessionRow[], keep: number): SessionRow[] {
  const rank = (row: SessionRow) => (row.liveness === 'away' ? 0 : 1);
  return [...open]
    .sort((a, b) => rank(a) - rank(b) || a.last_seen.localeCompare(b.last_seen))
    .slice(0, Math.max(0, open.length - keep));
}

/**
 * Makes room for one more session under `limits.maxSessionsPerAgent` by closing
 * the stalest, as expiry would later. A closed live session's plugin says hello
 * again and gets a new one. Returns how many it closed.
 */
export function evictStalest(
  ctx: HubContext,
  repo: SessionsRepo,
  agentId: string,
  at: string,
): number {
  const keep = ctx.loaded.config.limits.maxSessionsPerAgent - 1;
  const evicted = stalest(repo.listLive(agentId), keep);
  for (const row of evicted) releaseAndClose(ctx, repo, row.id, at, 'evicted');
  return evicted.length;
}
