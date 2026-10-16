import type { WorkflowRole } from '@agentmesh/config';
import type { Actor } from '../../../contracts';

/** The hub itself (see `systemActor`): a service carrying the `system` role. */
export function isSystemActor(actor: Actor): boolean {
  return actor.kind === 'service' && actor.roles.includes('system');
}

/** The task facts that decide relationship roles. */
export interface RoleSubject {
  assignee: string | null;
  createdBy: string;
}

/**
 * Workflow roles an actor holds on a task. `reviewers` are the reviewers of the
 * task's current round. Everyone holds `any`; the hub holds only `system` and `any`.
 */
export function rolesFor(
  actor: Actor,
  task: RoleSubject,
  reviewers: readonly string[],
): Set<WorkflowRole> {
  const roles = new Set<WorkflowRole>(['any']);
  if (isSystemActor(actor)) {
    roles.add('system');
    return roles;
  }
  if (actor.kind === 'agent') roles.add('agent');
  if (actor.kind === 'human') roles.add('human');
  if (task.assignee !== null && actor.id === task.assignee) roles.add('assignee');
  if (actor.id === task.createdBy) roles.add('creator');
  if (reviewers.includes(actor.id)) roles.add('reviewer');
  return roles;
}
