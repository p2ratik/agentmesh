import { MeshError } from '@agentmesh/common';
import type { WorkflowConfig, WorkflowRole, WorkflowTransition } from '@agentmesh/config';
import type { Actor } from '../../../contracts';
import { taskKey } from '../../../core/ids';
import type { TaskRecord } from '../repo';
import { ASSIGN_TO_ACTIONS } from './conventions';
import {
  type ActionInput,
  availableActions,
  findTransition,
  isSystemOnly,
  missingRequirements,
  permits,
} from './engine';

export interface ActionRequest {
  workflow: WorkflowConfig;
  task: TaskRecord;
  action: string;
  input: ActionInput;
  actor: Actor;
  roles: ReadonlySet<WorkflowRole>;
  isAgent(id: string): boolean;
}

export type ActionCheck = { transition: WorkflowTransition } | { error: MeshError };

/**
 * Decides whether an actor may run an action now, in this order: a transition
 * exists from the current state → the actor holds a permitted role → required
 * fields are present → convention targets (`to`, claimer) are valid agents.
 */
export function checkAction(req: ActionRequest): ActionCheck {
  const { workflow, task, action, input, roles } = req;
  const id = taskKey(task.id);
  const transition = findTransition(workflow, task.state, action);
  if (!transition) {
    const actions = availableActions(workflow, task.state, roles);
    const hint =
      actions.length > 0
        ? `Actions available to you: ${actions.join(', ')}.`
        : 'No actions are available to you.';
    return fail(
      'invalid_transition',
      `Cannot "${action}" ${id} in state "${task.state}". ${hint}`,
      { actions },
    );
  }
  if (!permits(transition, roles)) {
    const message = isSystemOnly(transition)
      ? `"${action}" on ${id} is performed by the hub automatically.`
      : `"${action}" on ${id} is for: ${transition.by.join(', ')}.`;
    return fail('forbidden', message);
  }
  const missing = missingRequirements(transition, input, task);
  if (missing.length > 0) {
    return fail('invalid_request', `"${action}" on ${id} requires: ${missing.join(', ')}.`, {
      missing,
    });
  }
  const targetError = checkTargets(req, transition);
  return targetError ? { error: targetError } : { transition };
}

function checkTargets(req: ActionRequest, transition: WorkflowTransition): MeshError | null {
  const { action, input, actor, task, isAgent } = req;
  const assigns = ASSIGN_TO_ACTIONS.has(action);
  if (assigns && !input.to) return new MeshError('invalid_request', `"${action}" needs "to".`);
  if (input.to && (assigns || transition.requires.includes('to'))) {
    if (!isAgent(input.to)) {
      return new MeshError('invalid_request', `"${input.to}" is not a configured agent.`);
    }
    if (assigns && input.to === task.assignee) {
      return new MeshError(
        'invalid_request',
        `${taskKey(task.id)} is already assigned to ${input.to}.`,
      );
    }
  }
  if (action === 'claim' && actor.kind !== 'agent') {
    return new MeshError('forbidden', 'Only agents can claim tasks.');
  }
  return null;
}

function fail(
  code: 'invalid_transition' | 'forbidden' | 'invalid_request',
  message: string,
  details?: Record<string, unknown>,
): ActionCheck {
  return { error: new MeshError(code, message, details) };
}
