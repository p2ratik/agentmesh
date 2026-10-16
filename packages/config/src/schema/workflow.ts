import { z } from 'zod';

/** Who may trigger a transition. `system` is the hub itself (auto-assign, review quorum). */
export const WorkflowRole = z.enum([
  'assignee',
  'reviewer',
  'creator',
  'human',
  'agent',
  'any',
  'system',
]);
export type WorkflowRole = z.infer<typeof WorkflowRole>;

/** Fields a transition needs from the caller. */
export const TransitionRequirement = z.enum(['note', 'prUrl', 'branch', 'to']);

/**
 * An effect is a named built-in behavior run when a state is entered or a
 * transition fires. Written either as `notify_assignee` or as
 * `{ post_notice: { channel: events, text: "…" } }`.
 */
export const EffectRef = z
  .union([z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))])
  .transform((ref, ctx) => {
    if (typeof ref === 'string') return { name: ref, params: {} as Record<string, unknown> };
    const entries = Object.entries(ref);
    if (entries.length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'An effect object must have exactly one key' });
      return z.NEVER;
    }
    const [name, params] = entries[0] as [string, Record<string, unknown>];
    return { name, params };
  });
export type EffectRef = z.output<typeof EffectRef>;

export const WorkflowState = z.object({
  label: z.string().optional(),
  terminal: z.boolean().default(false),
  onEnter: z.array(EffectRef).default([]),
});
export type WorkflowState = z.output<typeof WorkflowState>;

export const WorkflowTransition = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
  from: z.union([z.literal('*'), z.array(z.string()).min(1)]),
  to: z.string(),
  by: z.array(WorkflowRole).min(1),
  requires: z.array(TransitionRequirement).default([]),
  effects: z.array(EffectRef).default([]),
  description: z.string().optional(),
});
export type WorkflowTransition = z.output<typeof WorkflowTransition>;

export const WorkflowConfig = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  description: z.string().optional(),
  initial: z.string(),
  states: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), WorkflowState),
  transitions: z.array(WorkflowTransition).min(1),
});
export type WorkflowInput = z.input<typeof WorkflowConfig>;
export type WorkflowConfig = z.output<typeof WorkflowConfig>;
