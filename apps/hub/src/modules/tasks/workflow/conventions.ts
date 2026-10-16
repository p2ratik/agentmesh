import type { Actor } from '../../../contracts';
import type { TaskPatch, TaskRecord } from '../repo';
import type { ActionInput } from './engine';

/** Actions whose convention is to set the assignee to `to`. */
export const ASSIGN_TO_ACTIONS: ReadonlySet<string> = new Set(['assign', 'handoff']);
/** Actions that hand the task to a (possibly new) assignee. */
export const ASSIGNING_ACTIONS: ReadonlySet<string> = new Set(['assign', 'handoff', 'claim']);

/**
 * Field changes the hub applies by naming convention, on top of the state change:
 * `claim` → caller becomes assignee; `assign`/`handoff` → `to` becomes assignee;
 * `decline` → caller is remembered in `declinedBy`; `submit` → new review round.
 * A `prUrl` or `branch` passed with any action is stored.
 */
export function conventionPatch(
  action: string,
  actor: Actor,
  input: ActionInput,
  task: Pick<TaskRecord, 'declinedBy' | 'reviewRound'>,
): TaskPatch {
  const patch: TaskPatch = {};
  if (action === 'claim') patch.assignee = actor.id;
  if (ASSIGN_TO_ACTIONS.has(action) && input.to) patch.assignee = input.to;
  if (action === 'decline' && !task.declinedBy.includes(actor.id)) {
    patch.declinedBy = [...task.declinedBy, actor.id];
  }
  if (action === 'submit') patch.reviewRound = task.reviewRound + 1;
  if (input.prUrl?.trim()) patch.prUrl = input.prUrl.trim();
  if (input.branch?.trim()) patch.branch = input.branch.trim();
  return patch;
}
