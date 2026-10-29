import { z } from 'zod';
import { Plan, PlanContribution, PlanState, PlanTaskDraft } from '../planning';
import { IdRef } from '../primitives';
import { ANY_CALLER, defineMethod, PARTICIPANTS } from './define';

export const planningMethods = {
  'plan.start': defineMethod({
    description:
      'Start a team planning session: every participant proposes, then discusses, then the ' +
      'facilitator synthesizes a plan that becomes tasks.',
    callers: PARTICIPANTS,
    params: z.object({
      topic: z.string().min(3).max(4000),
      participants: z.array(IdRef).max(50).optional(),
      facilitator: IdRef.optional(),
      roundMinutes: z
        .number()
        .positive()
        .max(24 * 60)
        .optional(),
      template: IdRef.optional(),
    }),
    result: Plan,
  }),
  'plan.get': defineMethod({
    description: 'Fetch a plan with every contribution so far.',
    callers: ANY_CALLER,
    params: z.object({ planId: IdRef }),
    result: z.object({ plan: Plan, contributions: z.array(PlanContribution) }),
  }),
  'plan.list': defineMethod({
    description: 'List planning sessions, newest first.',
    callers: ANY_CALLER,
    params: z.object({
      state: z.array(PlanState).max(10).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    result: z.object({ plans: z.array(Plan) }),
  }),
  'plan.contribute': defineMethod({
    description: 'Add your contribution to the current round of a planning session.',
    callers: PARTICIPANTS,
    params: z.object({ planId: IdRef, body: z.string().min(1).max(32_000) }),
    result: z.object({ round: z.string(), roundComplete: z.boolean() }),
  }),
  'plan.submit': defineMethod({
    description: 'Facilitator only: submit the final plan as a summary plus task drafts.',
    callers: PARTICIPANTS,
    params: z.object({
      planId: IdRef,
      summary: z.string().min(1).max(32_000),
      tasks: z.array(PlanTaskDraft).min(1).max(100),
    }),
    result: Plan,
  }),
  'plan.approve': defineMethod({
    description: 'Approve a plan that is awaiting approval; its tasks are created and assigned.',
    callers: ['human'],
    params: z.object({ planId: IdRef }),
    result: Plan,
  }),
  'plan.cancel': defineMethod({
    description: 'Cancel a planning session.',
    callers: PARTICIPANTS,
    params: z.object({ planId: IdRef, reason: z.string().max(2000).optional() }),
    result: Plan,
  }),
} as const;
