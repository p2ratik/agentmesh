import { z } from 'zod';
import { GitRef, IdRef, Label, Priority } from '../primitives';
import { ReviewVerdict, Task, TaskDetail } from '../tasks';
import { ANY_CALLER, defineMethod, PARTICIPANTS } from './define';

export const TaskCreateParams = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(16_000).default(''),
  repo: GitRef.optional(),
  area: IdRef.optional(),
  assignee: IdRef.optional(),
  priority: Priority.default('normal'),
  labels: z.array(Label).max(20).default([]),
  doneWhen: z.string().max(2000).optional(),
  dependsOn: z.array(IdRef).max(50).default([]),
  baseBranch: GitRef.optional(),
  workflow: IdRef.optional(),
  parentThreadId: IdRef.optional(),
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
    params: z.object({ taskId: IdRef }),
    result: TaskDetail,
  }),
  'task.list': defineMethod({
    description: 'List tasks. `assignee: "me"` means the caller; `unassigned` lists the board.',
    callers: ANY_CALLER,
    params: z.object({
      assignee: IdRef.optional(),
      state: z.array(IdRef).max(20).optional(),
      area: IdRef.optional(),
      planId: IdRef.optional(),
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
      taskId: IdRef,
      action: z.string().min(1).max(60),
      note: z.string().max(8000).optional(),
      prUrl: z.string().max(500).optional(),
      branch: z.string().max(200).optional(),
      /** Target participant for `handoff` / `assign`. */
      to: IdRef.optional(),
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
      reviewers: z.array(IdRef).max(5).optional(),
      repo: GitRef.optional(),
      area: IdRef.optional(),
    }),
    result: TaskDetail,
  }),
  'review.submit': defineMethod({
    description: 'Submit your review verdict for a task you were asked to review.',
    callers: PARTICIPANTS,
    params: z.object({
      taskId: IdRef,
      verdict: ReviewVerdict,
      body: z.string().min(1).max(16_000),
    }),
    result: TaskDetail,
  }),
} as const;
