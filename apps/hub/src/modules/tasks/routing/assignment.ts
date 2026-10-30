/** An agent that could own a task, with the facts used to rank it. */
export interface AssignCandidate {
  id: string;
  online: boolean;
  /** Online with a push session, so work reaches it at once (not only on its next prompt). */
  instant: boolean;
  load: number;
  /** ISO time of the agent's last assignment; null if never assigned. */
  lastAssignedAt: string | null;
}

/**
 * Orders candidates: online first (when `preferOnline`), and among those the
 * ones reached at once over pull-only ones, then fewer active tasks, then least
 * recently assigned (never-assigned first). Ties keep the input order, which is
 * the configured preference order.
 */
export function rankCandidates(
  candidates: readonly AssignCandidate[],
  preferOnline: boolean,
): AssignCandidate[] {
  return [...candidates].sort((a, b) => {
    if (preferOnline && a.online !== b.online) return a.online ? -1 : 1;
    if (preferOnline && a.instant !== b.instant) return a.instant ? -1 : 1;
    if (a.load !== b.load) return a.load - b.load;
    return recency(a.lastAssignedAt) - recency(b.lastAssignedAt);
  });
}

const recency = (at: string | null): number => (at === null ? -1 : Date.parse(at));

export interface AssignmentRequest {
  /** Possible owners in preference order (see `ownerPool`). */
  pool: readonly string[];
  declinedBy: readonly string[];
  load: ReadonlyMap<string, number>;
  maxActive: number;
  preferOnline: boolean;
  isOnline(id: string): boolean;
  reachesInstantly(id: string): boolean;
  lastAssignedAt(id: string): string | null;
}

/** The best owner for a task, or null when nobody eligible has capacity. */
export function pickAssignee(req: AssignmentRequest): string | null {
  const candidates = req.pool
    .filter((id) => !req.declinedBy.includes(id))
    .map((id) => ({
      id,
      online: req.isOnline(id),
      instant: req.reachesInstantly(id),
      load: req.load.get(id) ?? 0,
      lastAssignedAt: req.lastAssignedAt(id),
    }))
    .filter((c) => c.load < req.maxActive);
  return rankCandidates(candidates, req.preferOnline)[0]?.id ?? null;
}
