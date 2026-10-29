import { z } from 'zod';
import { IsoDate, Priority, Trust } from './primitives';

export const ReviewVerdict = z.enum(['approve', 'request_changes', 'comment']);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const TaskReview = z.object({
  reviewer: z.string(),
  verdict: ReviewVerdict,
  body: z.string(),
  round: z.number().int().nonnegative(),
  createdAt: IsoDate,
});
export type TaskReview = z.infer<typeof TaskReview>;

/**
 * A unit of work. `state` and the available actions come from the task's
 * workflow, which is defined in configuration rather than hardcoded.
 */
export const Task = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  workflow: z.string(),
  state: z.string(),
  terminal: z.boolean(),
  priority: Priority,
  labels: z.array(z.string()),
  repo: z.string().nullable(),
  area: z.string().nullable(),
  baseBranch: z.string().nullable(),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  doneWhen: z.string().nullable(),
  assignee: z.string().nullable(),
  reviewers: z.array(z.string()),
  reviewRound: z.number().int().nonnegative(),
  createdBy: z.string(),
  planId: z.string().nullable(),
  threadId: z.string(),
  dependsOn: z.array(z.string()),
  /**
   * `external` for a task an event rule created: its title and description come from outside
   * the team. Older hubs send none; `team` reads their tasks as before.
   */
  trust: Trust.default('team'),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Task = z.infer<typeof Task>;

export const TaskHistoryEntry = z.object({
  at: IsoDate,
  actor: z.string(),
  action: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  note: z.string().nullable(),
});
export type TaskHistoryEntry = z.infer<typeof TaskHistoryEntry>;

export const TaskDetail = Task.extend({
  history: z.array(TaskHistoryEntry),
  reviews: z.array(TaskReview),
  /** Actions the caller may take right now, according to the workflow. */
  availableActions: z.array(z.string()),
});
export type TaskDetail = z.infer<typeof TaskDetail>;
