import { z } from 'zod';
import { formatPlan } from './format';
import { defineTool, withKey } from './types';

const DraftInput = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  title: z.string().min(3).max(200),
  description: z.string().default(''),
  area: z.string().optional(),
  repo: z.string().optional(),
  assignee: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  labels: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  done_when: z.string().optional(),
  estimate_hours: z.number().positive().optional(),
});

export const planningTools = [
  defineTool({
    name: 'plan_start',
    description:
      'Start a team planning session (every agent proposes, discusses, then a facilitator turns it into tasks).',
    input: z.object({
      topic: z.string().min(3),
      participants: z.array(z.string()).optional(),
      facilitator: z.string().optional(),
      round_minutes: z.number().positive().optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const plan = await hub.call(
        'plan.start',
        {
          topic: args.topic,
          ...(args.participants ? { participants: args.participants } : {}),
          ...(args.facilitator ? { facilitator: args.facilitator } : {}),
          ...(args.round_minutes ? { roundMinutes: args.round_minutes } : {}),
        },
        withKey(key),
      );
      return `Started ${plan.id}; facilitator ${plan.facilitator}; thread ${plan.threadId}.`;
    },
  }),
  defineTool({
    name: 'plan_get',
    description: 'Read a planning session with every contribution so far.',
    input: z.object({ plan_id: z.string() }),
    mutating: false,
    run: async (args, { hub }) => {
      const r = await hub.call('plan.get', { planId: args.plan_id });
      return formatPlan(r.plan, r.contributions);
    },
  }),
  defineTool({
    name: 'plan_contribute',
    description:
      'Add your contribution to the current round of a planning session (you may contribute more than once).',
    input: z.object({ plan_id: z.string(), body: z.string().min(1) }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const r = await hub.call(
        'plan.contribute',
        { planId: args.plan_id, body: args.body },
        withKey(key),
      );
      return `Contribution recorded for round "${r.round}"${r.roundComplete ? ' — the round is complete; the next step has started' : ''}.`;
    },
  }),
  defineTool({
    name: 'plan_submit',
    description:
      'Facilitator only: submit the final plan — a summary plus task drafts (each with a key; depends_on lists other keys).',
    input: z.object({
      plan_id: z.string(),
      summary: z.string().min(1),
      tasks: z.array(DraftInput).min(1),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const plan = await hub.call(
        'plan.submit',
        {
          planId: args.plan_id,
          summary: args.summary,
          tasks: args.tasks.map(({ depends_on, done_when, estimate_hours, ...rest }) => ({
            ...rest,
            ...(depends_on ? { dependsOn: depends_on } : {}),
            ...(done_when ? { doneWhen: done_when } : {}),
            ...(estimate_hours ? { estimateHours: estimate_hours } : {}),
          })),
        },
        withKey(key),
      );
      return plan.state === 'materialized'
        ? `${plan.id} is final; created ${plan.taskIds.join(', ')}.`
        : `${plan.id} is ${plan.state}.`;
    },
  }),
];
