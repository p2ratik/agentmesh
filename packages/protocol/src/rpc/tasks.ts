import { z } from 'zod';
import { Priority } from '../primitives';
import { ReviewVerdict, Task, TaskDetail } from '../tasks';
import { ANY_CALLER, defineMethod, PARTICIPANTS } from './define';

export const TaskCreateParams = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(16_000).default(''),
  repo: z.string().optional(),
  area: z.string().optional(),
  assignee: z.string().optional(),
  priority: Priority.default('normal'),
  labels: z.array(z.string()).max(20).default([]),
  doneWhen: z.string().max(2000).optional(),
  dependsOn: z.array(z.string()).max(50).default([]),
  baseBranch: z.string().optional(),
  workflow: z.string().optional(),
  parentThreadId: z.string().optional(),
});
export type TaskCreateParams = z.input<typeof TaskCreateParams>;

export const taskMethods = {
  'task.create': defineMethod({
    description: 'Create a task. Without an assignee the hub routes it by area ownership and load.',
    callers: ANY_CALLER,
    params: TaskCreateParams,
    result: TaskDetail,
  }),
  'task.get': defineMethod({
    description: 'Fetch a task with its history, reviews and the actions you can take.',
    callers: ANY_CALLER,
    params: z.object({ taskId: z.string() }),
    result: TaskDetail,
  }),
  'task.list': defineMethod({
    description: 'List tasks. `assignee: "me"` means the caller; `unassigned` lists the board.',
    callers: ANY_CALLER,
    params: z.object({
      assignee: z.string().optional(),
      state: z.array(z.string()).optional(),
      area: z.string().optional(),
      planId: z.string().optional(),
      includeTerminal: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    result: z.object({ tasks: z.array(Task) }),
  }),
  'task.act': defineMethod({
    description:
      'Apply a workflow action (accept, decline, start, block, unblock, submit, complete, ' +
      'handoff, claim, cancel…). Valid actions depend on the workflow and current state.',
    callers: PARTICIPANTS,
    params: z.object({
      taskId: z.string(),
      action: z.string().min(1).max(60),
      note: z.string().max(8000).optional(),
      prUrl: z.string().max(500).optional(),
      branch: z.string().max(200).optional(),
      /** Target participant for `handoff` / `assign`. */
      to: z.string().optional(),
    }),
    result: TaskDetail,
  }),
  'review.request': defineMethod({
    description: 'Ask for a review of a pull request; creates a review task and picks reviewers.',
    callers: PARTICIPANTS,
    params: z.object({
      prUrl: z.string().min(1).max(500),
      title: z.string().max(200).optional(),
      focus: z.string().max(4000).optional(),
      reviewers: z.array(z.string()).max(5).optional(),
      repo: z.string().optional(),
      area: z.string().optional(),
    }),
    result: TaskDetail,
  }),
  'review.submit': defineMethod({
    description: 'Submit your review verdict for a task you were asked to review.',
    callers: PARTICIPANTS,
    params: z.object({
      taskId: z.string(),
      verdict: ReviewVerdict,
      body: z.string().min(1).max(16_000),
    }),
    result: TaskDetail,
  }),
} as const;
