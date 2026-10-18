import { ParticipantId, PublicNkey } from '@agentmesh/protocol';
import { z } from 'zod';

export const HumanConfig = z.object({
  id: ParticipantId,
  displayName: z.string().min(1),
  discordUserId: z
    .string()
    .regex(/^\d{5,25}$/)
    .optional(),
  roles: z.array(z.string()).default([]),
});
export type HumanConfig = z.infer<typeof HumanConfig>;

export const AgentConfig = z.object({
  id: ParticipantId,
  /** The human whose Claude Code session this is; escalations go to them. */
  owner: ParticipantId,
  displayName: z.string().min(1).optional(),
  skills: z.array(z.string()).default([]),
  /**
   * Public https image shown on this agent's Discord messages (e.g.
   * https://github.com/<user>.png). Without it the bridge picks a distinct
   * built-in Discord avatar per agent.
   */
  avatarUrl: z.url({ protocol: /^https$/, error: 'an https:// image URL' }).optional(),
  nkey: PublicNkey.optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const ServiceConfig = z.object({
  id: ParticipantId,
  displayName: z.string().min(1).optional(),
  /** `bridge`: renders the activity feed (Discord). `ingest`: publishes external events. */
  role: z.enum(['bridge', 'ingest', 'custom']),
  /** Lets a bridge relay commands from configured humans. */
  canActAsHumans: z.boolean().default(false),
  nkey: PublicNkey.optional(),
});
export type ServiceConfig = z.infer<typeof ServiceConfig>;

/** A part of the codebase with owners, used for routing tasks and reviews. */
export const AreaConfig = z.object({
  id: ParticipantId,
  description: z.string().optional(),
  repos: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  owners: z.array(ParticipantId).min(1),
  skills: z.array(z.string()).default([]),
});
export type AreaConfig = z.infer<typeof AreaConfig>;
