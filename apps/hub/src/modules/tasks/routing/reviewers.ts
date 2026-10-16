import type { TaskReview } from '@agentmesh/protocol';

export interface ReviewerRequest {
  /** Never picked (the assignee, the requester). */
  exclude: readonly string[];
  areaOwners: readonly string[];
  /** Task labels plus area skills. */
  skills: ReadonlySet<string>;
  /** Every configured agent, in config order. */
  agents: ReadonlyArray<{ id: string; skills: readonly string[] }>;
  isOnline(id: string): boolean;
  load: ReadonlyMap<string, number>;
  max: number;
}

/**
 * Picks up to `max` reviewers. Tiers, in order: other owners of the area, agents
 * sharing a skill with the task, any other agent. Within a tier: online first,
 * then lower load, then config order.
 */
export function selectReviewers(req: ReviewerRequest): string[] {
  const excluded = new Set(req.exclude);
  const tier = (agent: { id: string; skills: readonly string[] }): number => {
    if (req.areaOwners.includes(agent.id)) return 0;
    return agent.skills.some((s) => req.skills.has(s)) ? 1 : 2;
  };
  return req.agents
    .filter((a) => !excluded.has(a.id))
    .map((a, order) => ({
      id: a.id,
      order,
      tier: tier(a),
      online: req.isOnline(a.id),
      load: req.load.get(a.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(b.online) - Number(a.online) ||
        a.load - b.load ||
        a.order - b.order,
    )
    .slice(0, req.max)
    .map((c) => c.id);
}

/**
 * Reviewers whose latest verdict in `round` is an approval. Comments do not
 * change a verdict; the assignee's own reviews never count.
 */
export function approversInRound(
  reviews: readonly TaskReview[],
  round: number,
  assignee: string | null,
): string[] {
  const latest = new Map<string, TaskReview['verdict']>();
  for (const r of reviews) {
    if (r.round !== round || r.verdict === 'comment' || r.reviewer === assignee) continue;
    latest.set(r.reviewer, r.verdict);
  }
  return [...latest].filter(([, verdict]) => verdict === 'approve').map(([id]) => id);
}
