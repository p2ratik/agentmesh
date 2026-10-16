import type { WorkflowConfig, WorkflowRole, WorkflowTransition } from '@agentmesh/config';

/**
 * Pure state-machine queries over a configured workflow. No I/O; everything the
 * hub decides about "what may happen next" goes through here.
 */

/** Values a caller passed with an action (subset of `task.act` params). */
export interface ActionInput {
  note?: string | undefined;
  prUrl?: string | undefined;
  branch?: string | undefined;
  to?: string | undefined;
}

export function isTerminalState(workflow: WorkflowConfig, state: string): boolean {
  return workflow.states[state]?.terminal ?? false;
}

/** Whether a transition can fire from `state`; `*` matches every non-terminal state. */
export function leavesFrom(
  workflow: WorkflowConfig,
  transition: WorkflowTransition,
  state: string,
): boolean {
  if (transition.from === '*') return !isTerminalState(workflow, state);
  return transition.from.includes(state);
}

/** The first transition for `action` that can fire from `state`. */
export function findTransition(
  workflow: WorkflowConfig,
  state: string,
  action: string,
): WorkflowTransition | undefined {
  return workflow.transitions.find((t) => t.action === action && leavesFrom(workflow, t, state));
}

export function permits(transition: WorkflowTransition, roles: ReadonlySet<WorkflowRole>): boolean {
  return transition.by.some((role) => roles.has(role));
}

export function isSystemOnly(transition: WorkflowTransition): boolean {
  return transition.by.every((role) => role === 'system');
}

/** Transitions from `state` that an actor holding `roles` may trigger (first per action). */
export function allowedTransitions(
  workflow: WorkflowConfig,
  state: string,
  roles: ReadonlySet<WorkflowRole>,
): WorkflowTransition[] {
  const seen = new Set<string>();
  const out: WorkflowTransition[] = [];
  for (const t of workflow.transitions) {
    if (seen.has(t.action) || !leavesFrom(workflow, t, state)) continue;
    seen.add(t.action);
    if (permits(t, roles)) out.push(t);
  }
  return out;
}

export function availableActions(
  workflow: WorkflowConfig,
  state: string,
  roles: ReadonlySet<WorkflowRole>,
): string[] {
  return allowedTransitions(workflow, state, roles).map((t) => t.action);
}

/** Required fields the caller did not supply. An existing PR URL satisfies `prUrl`. */
export function missingRequirements(
  transition: WorkflowTransition,
  input: ActionInput,
  task: { prUrl: string | null },
): string[] {
  const present = (value: string | null | undefined) => Boolean(value?.trim());
  return transition.requires.filter((field) => {
    if (field === 'prUrl') return !present(input.prUrl) && !present(task.prUrl);
    return !present(input[field]);
  });
}
