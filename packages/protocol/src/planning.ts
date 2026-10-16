import { z } from 'zod';
import { IsoDate, Priority } from './primitives';

export const PlanState = z.enum([
  'collecting', // discussion rounds are running
  'synthesizing', // the facilitator is drafting the plan
  'awaiting_approval', // a human must approve before tasks are created
  'materialized', // tasks were created
  'cancelled',
  'stalled', // nobody synthesized in time; a human was asked to step in
]);
export type PlanState = z.infer<typeof PlanState>;

export const PlanRound = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  minutes: z.number().positive(),
});
export type PlanRound = z.infer<typeof PlanRound>;

export const PlanTaskDraft = z.object({
  /** Local key so drafts can depend on each other before they have task ids. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  title: z.string().min(3).max(200),
  description: z.string().max(8000),
  area: z.string().optional(),
  repo: z.string().optional(),
  assignee: z.string().optional(),
  priority: Priority.optional(),
  labels: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  doneWhen: z.string().optional(),
  estimateHours: z.number().positive().optional(),
});
export type PlanTaskDraft = z.infer<typeof PlanTaskDraft>;

export const Plan = z.object({
  id: z.string(),
  topic: z.string(),
  state: PlanState,
  initiator: z.string(),
  facilitator: z.string(),
  participants: z.array(z.string()),
  threadId: z.string(),
  rounds: z.array(PlanRound),
  roundIndex: z.number().int().nonnegative(),
  currentRound: z.string().nullable(),
  deadline: IsoDate.nullable(),
  requireApproval: z.boolean(),
  summary: z.string().nullable(),
  drafts: z.array(PlanTaskDraft),
  taskIds: z.array(z.string()),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Plan = z.infer<typeof Plan>;

export const PlanContribution = z.object({
  planId: z.string(),
  round: z.string(),
  participant: z.string(),
  body: z.string(),
  createdAt: IsoDate,
});
export type PlanContribution = z.infer<typeof PlanContribution>;
