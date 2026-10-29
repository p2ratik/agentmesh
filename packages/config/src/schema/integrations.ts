import { ParticipantId } from '@agentmesh/protocol';
import { z } from 'zod';

export const IngestAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer'), token: z.string().min(16) }),
  z.object({
    type: z.literal('hmac-sha256'),
    secret: z.string().min(16),
    header: z.string().default('x-hub-signature-256'),
    prefix: z.string().default('sha256='),
  }),
  /** Development only; the hub refuses it unless `hub.allowInsecureIngest` is set. */
  z.object({ type: z.literal('none') }),
]);
export type IngestAuth = z.infer<typeof IngestAuth>;

export const IngestSource = z.object({
  id: ParticipantId,
  auth: IngestAuth,
  /**
   * `mesh`: the body is an IngestEvent. `raw`: any JSON (e.g. a GitHub webhook);
   * the whole body becomes `payload` and the type comes from a header/field.
   */
  format: z.enum(['mesh', 'raw']).default('mesh'),
  typeHeader: z.string().optional(),
  typeField: z.string().optional(),
  idHeader: z.string().optional(),
});
export type IngestSource = z.infer<typeof IngestSource>;

export const IngestConfig = z.object({
  sources: z.array(IngestSource).default([]),
  dedupWindowMinutes: z.number().int().positive().default(60),
  /** Days the hub keeps received events (audit and dedup); older ones are deleted. */
  retentionDays: z.number().int().positive().default(30),
});

/** Channel purposes the Discord bridge always needs. */
export const REQUIRED_CHANNEL_PURPOSES = [
  'council',
  'tasks',
  'planning',
  'escalations',
  'events',
] as const;

export const DiscordChannel = z.object({
  name: z.string().regex(/^[a-z0-9-_]{1,100}$/),
  type: z.enum(['text', 'forum']).default('text'),
  topic: z.string().optional(),
});

export const DiscordConfig = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(''),
  applicationId: z.string().default(''),
  guildId: z.string().default(''),
  provision: z
    .object({ enabled: z.boolean().default(true), category: z.string().default('Agent Mesh') })
    .prefault({}),
  /** Keyed by purpose; `reviews` falls back to `tasks`, `alerts` to `events`. */
  channels: z.record(z.string(), DiscordChannel).default({
    council: { name: 'mesh-council', type: 'text' },
    tasks: { name: 'mesh-tasks', type: 'text' },
    reviews: { name: 'mesh-reviews', type: 'text' },
    planning: { name: 'mesh-planning', type: 'forum' },
    escalations: { name: 'mesh-escalations', type: 'text' },
    events: { name: 'mesh-events', type: 'text' },
    alerts: { name: 'mesh-alerts', type: 'text' },
  }),
  /** Service participant id the bridge authenticates as. */
  serviceId: ParticipantId.default('discord-bridge'),
});
export type DiscordConfig = z.infer<typeof DiscordConfig>;
