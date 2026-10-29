import { DAY_MS } from '@agentmesh/common';
import type { HubContext } from '../../context';
import type { SessionRow, SessionsRepo } from './sessions.repo';

/** Closed sessions are kept this long (a returning process reclaims from its closed one), then deleted. */
const CLOSED_RETENTION_MS = 30 * DAY_MS;

/** Releases the session's threads and closes it; shared by `session.bye` and expiry. */
export function releaseAndClose(repo: SessionsRepo, sessionId: string, at: string): number[] {
  const released = repo.releaseOwned(sessionId);
  repo.close(sessionId, at);
  return released;
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
    for (const row of stale) repo.markAway(row.id, at);
    const expired = repo.awayBefore(graceBefore);
    for (const row of expired) releaseAndClose(repo, row.id, at);
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
  for (const row of evicted) releaseAndClose(repo, row.id, at);
  return evicted.length;
}
