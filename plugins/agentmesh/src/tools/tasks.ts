import { z } from 'zod';
import { checkoutLine, isOwnerName } from '../window/checkouts';
import { localSessionsLine } from '../window/local-sessions';
import { formatTask, formatTaskLine } from './format';
import { defineTool, withKey } from './types';

const Priority = z.enum(['low', 'normal', 'high', 'urgent']);

export const taskTools = [
  defineTool({
    name: 'task_create',
    description:
      'Create a task for the team. Without an assignee the hub routes it to the least-loaded owner of its area (or the board). Use depends_on for ordering.',
    input: z.object({
      title: z.string().min(3).max(200),
      description: z
        .string()
        .max(16_000)
        .optional()
        .describe(
          'Up to 16,000 characters. From a private session, the handoff note: what you learned, files and lines, decisions made, what is open and who to ask. Everyone in the Discord server can read it.',
        ),
      repo: z.string().optional(),
      area: z.string().optional(),
      assignee: z.string().optional(),
      priority: Priority.optional(),
      labels: z.array(z.string()).optional(),
      done_when: z.string().optional(),
      depends_on: z.array(z.string()).optional(),
      base_branch: z.string().optional(),
      parent_thread_id: z.string().optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const task = await hub.call(
        'task.create',
        {
          title: args.title,
          description: args.description ?? '',
          ...(args.repo ? { repo: args.repo } : {}),
          ...(args.area ? { area: args.area } : {}),
          ...(args.assignee ? { assignee: args.assignee } : {}),
          priority: args.priority ?? 'normal',
          labels: args.labels ?? [],
          ...(args.done_when ? { doneWhen: args.done_when } : {}),
          dependsOn: args.depends_on ?? [],
          ...(args.base_branch ? { baseBranch: args.base_branch } : {}),
          ...(args.parent_thread_id ? { parentThreadId: args.parent_thread_id } : {}),
        },
        withKey(key),
      );
      return `Created ${task.id} [${task.state}] → ${task.assignee ?? 'unassigned (board)'} · thread ${task.threadId}`;
    },
  }),
  defineTool({
    name: 'task_list',
    description:
      'List tasks. Defaults to yours ("me"); "all" for everyone, "unassigned" for the board, or an agent id.',
    input: z.object({
      assignee: z.string().optional(),
      state: z.array(z.string()).optional(),
      area: z.string().optional(),
      plan_id: z.string().optional(),
      include_done: z.boolean().optional(),
    }),
    mutating: false,
    run: async (args, { hub }) => {
      const assignee = args.assignee ?? 'me';
      const { tasks } = await hub.call('task.list', {
        // The hub lists every task when the assignee is absent.
        ...(assignee === 'all' ? {} : { assignee }),
        ...(args.state ? { state: args.state } : {}),
        ...(args.area ? { area: args.area } : {}),
        ...(args.plan_id ? { planId: args.plan_id } : {}),
        includeTerminal: args.include_done ?? false,
      });
      return tasks.length > 0 ? tasks.map(formatTaskLine).join('\n') : 'No matching tasks.';
    },
  }),
  defineTool({
    name: 'task_get',
    description:
      'Full task details: state, branch, PR, reviews, history and the actions you can take now.',
    input: z.object({ task_id: z.string() }),
    mutating: false,
    run: async (args, { hub, window, prefix, agentId }) => {
      const task = await hub.call('task.get', { taskId: args.task_id });
      const out = formatTask(task);
      if (window.state !== 'verified') return out;
      const lines = [out, checkoutLine(task.repo, window.folder)];
      if (task.repo && isOwnerName(task.repo)) {
        const deps = { dataDir: window.dataDir, prefix, agentId, now: Date.now() };
        lines.push(localSessionsLine(task.repo, deps));
      }
      return lines.join('\n');
    },
  }),
  defineTool({
    name: 'task_act',
    description:
      'Move a task through its workflow: accept, decline (note), handoff (to, note), claim, block (note), unblock, submit (pr_url, branch), complete, cancel… task_get lists what you can do.',
    input: z.object({
      task_id: z.string(),
      action: z.string().min(1),
      note: z.string().optional(),
      pr_url: z.string().optional(),
      branch: z
        .string()
        .optional()
        .describe("With submit: the PR's branch, so reviewers can diff it."),
      to: z.string().optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const task = await hub.call(
        'task.act',
        {
          taskId: args.task_id,
          action: args.action,
          ...(args.note ? { note: args.note } : {}),
          ...(args.pr_url ? { prUrl: args.pr_url } : {}),
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.to ? { to: args.to } : {}),
        },
        withKey(key),
      );
      return `${task.id} is now ${task.state} (assignee ${task.assignee ?? 'none'}). Next for you: ${task.availableActions.join(', ') || 'nothing'}.`;
    },
  }),
  defineTool({
    name: 'request_review',
    description:
      'Ask teammates to review a pull request that is not tied to a task (reviewers are picked if you omit them).',
    input: z.object({
      pr_url: z.string().min(1),
      title: z.string().optional(),
      focus: z.string().optional(),
      reviewers: z.array(z.string()).optional(),
      repo: z.string().optional(),
      branch: z.string().optional().describe("The PR's branch, so reviewers can diff it."),
      area: z.string().optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const task = await hub.call(
        'review.request',
        {
          prUrl: args.pr_url,
          ...(args.title ? { title: args.title } : {}),
          ...(args.focus ? { focus: args.focus } : {}),
          ...(args.reviewers ? { reviewers: args.reviewers } : {}),
          ...(args.repo ? { repo: args.repo } : {}),
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.area ? { area: args.area } : {}),
        },
        withKey(key),
      );
      return `Review requested as ${task.id}; reviewers: ${task.reviewers.join(', ') || 'none available'}.`;
    },
  }),
  defineTool({
    name: 'review_submit',
    description:
      'Submit your verdict on a task you were asked to review: approve, request_changes or comment.',
    input: z.object({
      task_id: z.string(),
      verdict: z.enum(['approve', 'request_changes', 'comment']),
      body: z.string().min(1),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const task = await hub.call(
        'review.submit',
        { taskId: args.task_id, verdict: args.verdict, body: args.body },
        withKey(key),
      );
      return `Review recorded on ${task.id}; task is now ${task.state}.`;
    },
  }),
];
