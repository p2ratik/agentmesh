import { PlanRound } from '@agentmesh/protocol';
import { z } from 'zod';

export const PlanningTemplate = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  description: z.string().optional(),
  rounds: z.array(PlanRound).min(1),
  synthesis: z.object({
    minutes: z.number().positive(),
    prompt: z.string(),
  }),
});
export type PlanningTemplate = z.infer<typeof PlanningTemplate>;

export const PlanningConfig = z.object({
  /** `initiator` = the agent of whoever ran /plan (or the agent that started it). */
  facilitator: z.string().default('initiator'),
  /** `false` turns an approved plan into tasks without a human step. */
  requireApproval: z.boolean().default(false),
  /** Rounds end early once this share of online participants contributed. */
  quorum: z.number().min(0).max(1).default(1),
  defaultTemplate: z.string().default('standard'),
  templates: z.array(PlanningTemplate).default([]),
});
export type PlanningConfig = z.infer<typeof PlanningConfig>;
