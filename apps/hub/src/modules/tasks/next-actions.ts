import type { TaskRecord } from './repo';
import type { NextAction } from './types';
import type { TaskViews } from './views';
import { allowedTransitions, missingRequirements } from './workflow/engine';

/** What a participant may do next on a task, with the fields each action still needs. */
export function nextActionsFor(
  views: TaskViews,
  task: TaskRecord,
  participantId: string,
): NextAction[] {
  const workflow = views.workflowOf(task);
  if (!workflow) return [];
  const roles = views.rolesOfParticipant(participantId, task);
  return allowedTransitions(workflow, task.state, roles).map((t) => ({
    action: t.action,
    missing: missingRequirements(t, {}, task),
  }));
}
