import { MeshError, redactSecrets } from '@agentmesh/common';
import type { RpcHandlerMap } from '../../contracts';
import { internalId } from '../../core/ids';
import type { TaskServiceImpl } from './tasks.service';

type TaskHandlers = Pick<
  RpcHandlerMap,
  'task.create' | 'task.get' | 'task.list' | 'task.act' | 'review.request' | 'review.submit'
>;

const taskId = (raw: string) => internalId('task', raw);

/**
 * RPC surface of the task module: protocol ids in, protocol shapes out. Calls
 * that change a task pass `call.notes`: the caller is never echoed its own
 * call, and gets what it must still learn as notes on its result.
 * Titles are redacted here, where they come in: the thread subject and the
 * branch name cut them, and a cut token no longer matches. (Rules redact their
 * titles in their own action, before cutting them.)
 */
export function taskHandlers(tasks: TaskServiceImpl): TaskHandlers {
  return {
    'task.create': (params, call) =>
      tasks.create(
        {
          title: redactSecrets(params.title),
          description: params.description,
          repo: params.repo,
          area: params.area,
          assignee: params.assignee,
          priority: params.priority,
          labels: params.labels,
          doneWhen: params.doneWhen,
          dependsOn: params.dependsOn.map(taskId),
          baseBranch: params.baseBranch,
          workflow: params.workflow,
          parentThreadId: params.parentThreadId
            ? internalId('thread', params.parentThreadId)
            : undefined,
        },
        call.actor,
        call.notes,
      ),

    'task.get': (params, call) => tasks.get(taskId(params.taskId), call.actor),

    'task.list': (params, call) => {
      const assignee = params.assignee === 'me' ? call.actor.id : params.assignee;
      return {
        tasks: tasks.list({
          assignee: assignee && assignee !== 'unassigned' ? assignee : null,
          unassigned: assignee === 'unassigned',
          states: params.state ?? null,
          area: params.area ?? null,
          planId: params.planId ? internalId('plan', params.planId) : null,
          includeTerminal: params.includeTerminal,
          limit: params.limit,
        }),
      };
    },

    'task.act': (params, call) =>
      tasks.act(
        taskId(params.taskId),
        params.action,
        { note: params.note, prUrl: params.prUrl, branch: params.branch, to: params.to },
        call.actor,
        call.notes,
      ),

    /** A stand-alone PR review: the requester (if an agent) owns it; reviewers are picked or given. */
    'review.request': (params, call) => {
      const { actor } = call;
      if (!tasks.views.index.workflow('review')) {
        throw new MeshError('invalid_request', 'This mesh has no "review" workflow configured');
      }
      return tasks.create(
        {
          title: redactSecrets(params.title ?? `Review ${params.prUrl}`),
          description: params.focus ?? '',
          repo: params.repo,
          area: params.area,
          assignee: actor.kind === 'agent' ? actor.id : undefined,
          priority: 'normal',
          labels: [],
          dependsOn: [],
          workflow: 'review',
          prUrl: params.prUrl,
          reviewers: (params.reviewers ?? []).filter((id) => id !== actor.id),
        },
        actor,
        call.notes,
      );
    },

    'review.submit': (params, call) =>
      tasks.submitReview(
        taskId(params.taskId),
        params.verdict,
        params.body,
        call.actor,
        call.notes,
      ),
  };
}
