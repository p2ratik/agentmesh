import { nextActionsFor } from '../next-actions';
import {
  approvedBrief,
  assignmentBrief,
  changesRequestedBrief,
  creatorUpdate,
  stateBrief,
} from '../text';
import { ASSIGNING_ACTIONS } from '../workflow/conventions';
import { isTerminalState } from '../workflow/engine';
import { assigneeNoticeClass, creatorNoticeClass } from './classes';
import type { Effect, EffectEnv, EffectRun } from './types';

/**
 * A detailed brief for the assignee, shaped by what just happened: an
 * assignment gets the full brief (branch, base, dependencies, next calls);
 * review outcomes and terminal states get focused notes. The assignee is not
 * told about their own actions (a claim included: its result shows the task).
 */
export const notifyAssignee: Effect = (env, run) => {
  const { task } = run;
  const assignee = task.assignee;
  if (!assignee || assignee === run.actor.id) return;
  env.post({
    threadId: task.threadId,
    senderId: env.deps.messaging.hubId,
    kind: 'task',
    body: assigneeBody(env, run, assignee),
    to: [assignee],
    trust: task.trust,
    refs: { action: run.action ?? 'assigned' },
    deliveryClass: assigneeNoticeClass(run.action),
  });
};

function assigneeBody(env: EffectEnv, run: EffectRun, assignee: string): string {
  const { task, workflow } = run;
  const next = nextActionsFor(env.views, task, assignee);
  if (run.action === null || ASSIGNING_ACTIONS.has(run.action)) {
    return assignmentBrief({
      task,
      index: env.ctx.index,
      assignee,
      dependencies: env.views.dependencies(task.id),
      next,
    });
  }
  if (run.action === 'request_changes') {
    return changesRequestedBrief(task, env.repos.reviews.list(task.id, task.reviewRound), next);
  }
  if (run.action === 'approve') return approvedBrief(task, env.ctx.index, next);
  const label = workflow.states[task.state]?.label ?? task.state;
  return stateBrief(
    task,
    isTerminalState(workflow, task.state) ? label.toLowerCase() : label,
    next,
  );
}

/** A one-line update for whoever created the task (unless they caused it or own it). */
export const notifyCreator: Effect = (env, run) => {
  const { task } = run;
  const creator = task.createdBy;
  const { messaging } = env.deps;
  if (creator === run.actor.id || creator === task.assignee || creator === messaging.hubId) return;
  if (env.ctx.index.kindOf(creator) === undefined) return;
  env.post({
    threadId: task.threadId,
    senderId: messaging.hubId,
    kind: 'task',
    body: creatorUpdate(
      task,
      run.action ?? 'update',
      task.state,
      env.ctx.index.displayName(run.actor.id),
    ),
    to: [creator],
    trust: task.trust,
    refs: { action: run.action ?? 'update' },
    deliveryClass: creatorNoticeClass(run.workflow.states[task.state]),
  });
};
