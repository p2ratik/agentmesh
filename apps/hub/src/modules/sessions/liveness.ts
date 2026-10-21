import type { HubContext } from '../../context';
import type { SessionsRepo } from './sessions.repo';

/** Releases the session's threads and closes it; shared by `session.bye` and expiry. */
export function releaseAndClose(repo: SessionsRepo, sessionId: string, at: string): number[] {
  const released = repo.releaseOwned(sessionId);
  repo.close(sessionId, at, released);
  return released;
}

/**
 * Silent live sessions go away (they keep their work); away ones close after
 * `presence.ownershipGraceMinutes`, which releases what they owned.
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
  return result;
}
