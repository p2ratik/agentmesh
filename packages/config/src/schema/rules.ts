import { DeliveryClass, Priority, Severity } from '@agentmesh/protocol';
import { z } from 'zod';

/** A condition on one value inside the event (`payload.branch`, `severity`, …). */
export const Condition = z
  .object({
    equals: z.unknown().optional(),
    in: z.array(z.unknown()).optional(),
    exists: z.boolean().optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
    gte: z.number().optional(),
    lte: z.number().optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), 'empty condition');
export type Condition = z.infer<typeof Condition>;

const OneOrMany = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const RuleMatch = z.object({
  source: OneOrMany.optional(),
  /** Exact types, or prefixes ending in `*` (e.g. `workflow_run.*`). */
  type: OneOrMany.optional(),
  minSeverity: Severity.optional(),
  where: z.record(z.string(), Condition).default({}),
});
export type RuleMatch = z.output<typeof RuleMatch>;

/** Text fields support `{{path}}` placeholders, e.g. `{{payload.repo}}`. */
const Template = z.string();

/** A configured id, never a template: an outside event must not pick who gets the work. */
const FixedId = z
  .string()
  .refine((v) => !v.includes('{{'), 'must be a configured id, not a {{template}}');

export const NotifyAction = z.object({
  notify: z.object({
    to: z.union([z.enum(['area-owners', 'online', 'all-agents']), z.array(z.string()).min(1)]),
    area: Template.optional(),
    repo: Template.optional(),
    subject: Template.optional(),
    text: Template,
    /** `status` notices ride along as FYI instead of interrupting the recipient. */
    class: DeliveryClass.default('action'),
  }),
});

export const CreateTaskAction = z.object({
  create_task: z.object({
    title: Template,
    description: Template.optional(),
    area: FixedId.optional(),
    repo: Template.optional(),
    assignee: FixedId.optional(),
    priority: Priority.optional(),
    labels: z.array(z.string()).optional(),
    workflow: z.string().optional(),
  }),
});

export const NoticeAction = z.object({
  notice: z.object({ channel: z.string(), text: Template }),
});

export const RuleAction = z.union([NotifyAction, CreateTaskAction, NoticeAction]);
export type RuleAction = z.infer<typeof RuleAction>;

export const RuleConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  match: RuleMatch,
  actions: z.array(RuleAction).min(1),
  /** Suppress repeats: at most one firing per rendered key per window. */
  throttle: z.object({ key: Template, windowMinutes: z.number().positive() }).optional(),
  /** Stop evaluating later rules once this one matched. */
  stop: z.boolean().default(false),
});
export type RuleInput = z.input<typeof RuleConfig>;
export type RuleConfig = z.output<typeof RuleConfig>;
