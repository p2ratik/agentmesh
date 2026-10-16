import { PREFIX_PATTERN } from '@agentmesh/protocol';
import { z } from 'zod';
import { DiscordConfig, IngestConfig } from './integrations';
import { PlanningConfig } from './planning';
import {
  AssignmentConfig,
  GitConfig,
  LeaseConfig,
  LimitsConfig,
  PolicyConfig,
  PresenceConfig,
  ReviewConfig,
} from './policy';
import { RuleConfig } from './rules';
import { AgentConfig, AreaConfig, HumanConfig, ServiceConfig } from './team';
import { WorkflowConfig } from './workflow';

// `.prefault({})` (not `.default`) so omitted sections still get their inner defaults.
export const MeshConfigSchema = z.object({
  version: z.literal(1),
  mesh: z.object({
    name: z.string().min(1),
    prefix: z.string().regex(PREFIX_PATTERN).default('mesh'),
  }),
  nats: z
    .object({
      servers: z
        .union([z.string(), z.array(z.string())])
        .default('nats://localhost:4222')
        .transform((v) => (Array.isArray(v) ? v : [v])),
    })
    .prefault({}),
  hub: z
    .object({
      serviceId: z.string().default('hub'),
      /** Public nkey of the hub's NATS user (see `agentmesh keys add hub`). */
      nkey: z
        .string()
        .regex(/^U[A-Z2-7]{55}$/)
        .optional(),
      dataDir: z.string().default('./data'),
      http: z
        .object({
          enabled: z.boolean().default(true),
          host: z.string().default('0.0.0.0'),
          port: z.number().int().min(1).max(65_535).default(8787),
        })
        .prefault({}),
      allowInsecureIngest: z.boolean().default(false),
      tickSeconds: z.number().int().min(1).default(10),
    })
    .prefault({}),
  humans: z.array(HumanConfig).min(1),
  agents: z.array(AgentConfig).default([]),
  services: z.array(ServiceConfig).default([]),
  areas: z.array(AreaConfig).default([]),
  git: GitConfig.prefault({}),
  policy: PolicyConfig.prefault({}),
  limits: LimitsConfig.prefault({}),
  assignment: AssignmentConfig.prefault({}),
  review: ReviewConfig.prefault({}),
  leases: LeaseConfig.prefault({}),
  presence: PresenceConfig.prefault({}),
  planning: PlanningConfig.prefault({}),
  tasks: z.object({ defaultWorkflow: z.string().default('feature') }).prefault({}),
  /** Inline definitions; files from `include` directories are merged in by the loader. */
  workflows: z.array(WorkflowConfig).default([]),
  rules: z.array(RuleConfig).default([]),
  include: z
    .object({
      workflows: z.array(z.string()).default(['workflows']),
      rules: z.array(z.string()).default(['rules']),
    })
    .prefault({}),
  ingest: IngestConfig.prefault({}),
  discord: DiscordConfig.prefault({}),
});

export type MeshConfigInput = z.input<typeof MeshConfigSchema>;
export type MeshConfig = z.output<typeof MeshConfigSchema>;
