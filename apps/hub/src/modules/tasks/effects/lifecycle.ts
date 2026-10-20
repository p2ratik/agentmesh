import { redactSecrets } from '@agentmesh/common';
import { taskKey } from '../../../core/ids';
import { dependenciesDoneText } from '../text';
import { autoAssign } from './assign';
import type { Effect } from './types';

/** Routes or wakes up tasks that were waiting for this one. */
export const releaseDependents: Effect = (env, run) => {
  const { repos, views, deps } = env;
  for (const id of repos.dependencies.dependents(run.task.id)) {
    const dependent = repos.tasks.require(id);
    const workflow = views.workflowOf(dependent);
    if (!workflow || views.isTerminal(dependent) || !views.dependenciesDone(id)) continue;
    if (!dependent.assignee) {
      if (dependent.state === workflow.initial) {
        autoAssign(env, {
          ...run,
          task: dependent,
          workflow,
          action: null,
          from: null,
          params: {},
        });
      }
      continue;
    }
    env.post({
      threadId: dependent.threadId,
      senderId: deps.messaging.hubId,
      kind: 'task',
      body: dependenciesDoneText(dependent),
      to: [dependent.assignee],
      trust: dependent.trust,
      refs: { action: 'dependencies_done' },
    });
  }
};

export const releaseLeases: Effect = (env, run) => {
  env.deps.leases.releaseForTask(run.task.id);
};

export const clearAssignee: Effect = (env, run) => {
  env.repos.tasks.update(run.task.id, { assignee: null }, env.ctx.clock.now().toISOString());
};

/** Closes after every queued message of the operation has been posted. */
export const closeThread: Effect = (env, run) => {
  env.op.closeThread(run.task.threadId, env.deps.messaging.hubId);
};

/**
 * `{ post_notice: { channel, text } }` — text may use {{task.id}} {{task.title}} {{task.state}} {{task.assignee}} {{actor}}.
 * Each value is redacted before it is filled in; the template is trusted config, and the bridge
 * posts notices as they are (masking the finished text would match across template and value).
 */
export const postNotice: Effect = (env, run) => {
  const channel = typeof run.params.channel === 'string' ? run.params.channel : 'events';
  const template =
    typeof run.params.text === 'string' ? run.params.text : '{{task.id}} → {{task.state}}';
  const values: Record<string, string> = {
    'task.id': taskKey(run.task.id),
    'task.title': run.task.title,
    'task.state': run.task.state,
    'task.assignee': run.task.assignee ?? 'unassigned',
    actor: run.actor.id,
  };
  // Own keys only: `{{constructor}}` would otherwise find a function and fail the transition.
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) =>
    Object.hasOwn(values, key) ? redactSecrets(values[key] ?? '') : '',
  );
  env.ctx.outbox.enqueueEvent('notice.posted', { channel, text, severity: 'info' });
};
