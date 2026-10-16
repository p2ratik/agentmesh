import type { PlanTaskDraft } from '@agentmesh/protocol';

export interface DraftCheck {
  /** Drafts in dependency order (dependencies first), with invalid assignees dropped. */
  ordered: PlanTaskDraft[];
  /** Problems the facilitator must fix; empty when the plan is valid. */
  issues: string[];
}

export interface DraftLookups {
  isAgent(id: string): boolean;
  isArea(id: string): boolean;
}

/**
 * Validates a facilitator's task drafts: unique keys, known dependency keys,
 * known areas, no dependency cycles. An assignee that is not an agent is
 * dropped (routing picks one) rather than failing the whole plan.
 */
export function checkDrafts(drafts: readonly PlanTaskDraft[], lookups: DraftLookups): DraftCheck {
  const issues: string[] = [];
  const byKey = new Map<string, PlanTaskDraft>();
  for (const draft of drafts) {
    if (byKey.has(draft.key)) issues.push(`duplicate task key "${draft.key}"`);
    byKey.set(draft.key, cleanAssignee(draft, lookups));
  }
  for (const draft of drafts) issues.push(...referenceIssues(draft, byKey, lookups));
  if (issues.length > 0) return { ordered: [], issues };
  const ordered = topologicalOrder([...byKey.values()]);
  if (!ordered) return { ordered: [], issues: ['task dependencies form a cycle'] };
  return { ordered, issues: [] };
}

function referenceIssues(
  draft: PlanTaskDraft,
  byKey: ReadonlyMap<string, PlanTaskDraft>,
  lookups: DraftLookups,
): string[] {
  const issues: string[] = [];
  for (const dep of draft.dependsOn ?? []) {
    if (!byKey.has(dep)) issues.push(`"${draft.key}" depends on unknown key "${dep}"`);
    if (dep === draft.key) issues.push(`"${draft.key}" depends on itself`);
  }
  if (draft.area && !lookups.isArea(draft.area)) {
    issues.push(`"${draft.key}" uses unknown area "${draft.area}"`);
  }
  return issues;
}

function cleanAssignee(draft: PlanTaskDraft, lookups: DraftLookups): PlanTaskDraft {
  if (!draft.assignee || lookups.isAgent(draft.assignee)) return draft;
  const { assignee: _dropped, ...rest } = draft;
  return rest;
}

/** Kahn's algorithm, stable with respect to the input order. Null on a cycle. */
export function topologicalOrder(drafts: readonly PlanTaskDraft[]): PlanTaskDraft[] | null {
  const remaining = new Map(drafts.map((d) => [d.key, new Set(d.dependsOn ?? [])]));
  const ordered: PlanTaskDraft[] = [];
  while (remaining.size > 0) {
    const ready = drafts.filter((d) => remaining.get(d.key)?.size === 0);
    if (ready.length === 0) return null;
    for (const draft of ready) {
      ordered.push(draft);
      remaining.delete(draft.key);
      for (const deps of remaining.values()) deps.delete(draft.key);
    }
  }
  return ordered;
}
