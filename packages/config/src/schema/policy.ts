import { isSafeInviteUrl } from '@agentmesh/protocol';
import { z } from 'zod';

export const GitConfig = z.object({
  /** Long-lived branch agents merge into after peer review; humans promote it to main. */
  integrationBranch: z.string().default('agents'),
  protectedBranches: z.array(z.string()).default(['main']),
  /** Placeholders: {owner}, {agent}, {task}, {slug}. */
  branchTemplate: z.string().default('agent/{owner}/{task}-{slug}'),
  agentsMayMergeInto: z.array(z.string()).default(['agents']),
});
export type GitConfig = z.infer<typeof GitConfig>;

export const PolicyConfig = z.object({
  /** Markdown team policy appended to every agent's channel instructions. */
  instructionsFile: z.string().optional(),
  instructions: z.string().optional(),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export const LimitsConfig = z.object({
  /** A→B→C→D: how deep a chain of agent-created threads may go. */
  maxThreadDepth: z.number().int().min(1).max(20).default(3),
  perThreadPerHour: z.number().int().positive().default(40),
  perSenderPerDay: z.number().int().positive().default(500),
  dedupWindowSeconds: z.number().int().nonnegative().default(120),
  maxBodyChars: z.number().int().positive().default(32_000),
  /**
   * Calls that change state (task, plan, review, lease, session and message RPCs; reads are
   * free), per agent or human: `rpcBurst` at once, refilled at `rpcPerMinute`.
   */
  rpcBurst: z.number().int().positive().default(60),
  rpcPerMinute: z.number().int().positive().default(20),
  /** Open (live or away) sessions per agent; a new one closes the stalest beyond this. */
  maxSessionsPerAgent: z.number().int().positive().default(20),
});
export type LimitsConfig = z.infer<typeof LimitsConfig>;

export const AssignmentConfig = z.object({
  maxActiveTasksPerAgent: z.number().int().positive().default(3),
  preferOnline: z.boolean().default(true),
  /** Who hears about unowned tasks on the board. */
  boardAnnounce: z.enum(['matching-skills', 'online', 'none']).default('matching-skills'),
});
export type AssignmentConfig = z.infer<typeof AssignmentConfig>;

export const ReviewConfig = z.object({
  requiredApprovals: z.number().int().min(0).max(5).default(1),
  maxReviewers: z.number().int().min(1).max(5).default(2),
  /** Humans who are always added as reviewers (optional). */
  humanReviewers: z.array(z.string()).default([]),
});
export type ReviewConfig = z.infer<typeof ReviewConfig>;

export const LeaseConfig = z.object({
  defaultTtlMinutes: z.number().int().positive().default(120),
});

/** Invite-only onboarding (`/mesh invite`, `/agentmesh:join`). */
export const EnrollmentConfig = z.object({
  /**
   * The NATS URL new members' laptops connect to, written into every invite code.
   * Must be tls:// or wss:// (plaintext only for localhost). Without it, /mesh invite is refused.
   */
  natsUrl: z
    .string()
    .refine(isSafeInviteUrl, 'a tls:// or wss:// URL (nats:// and ws:// only for localhost)')
    .optional(),
  /** How long an unused invite code stays valid. */
  inviteTtlHours: z.number().positive().max(720).default(24),
  /** Lifetime of the NATS user JWT the hub issues on connect; a backstop if a kick is lost. */
  userJwtTtlMinutes: z.number().int().min(5).max(1440).default(60),
  /** Failed invite redemptions allowed per minute, per invite and per client IP. */
  redeemAttemptsPerMinute: z.number().int().min(1).default(5),
});

export const PresenceConfig = z.object({
  heartbeatSeconds: z.number().int().min(5).default(20),
  offlineAfterSeconds: z.number().int().min(10).default(75),
  /** How long a silent (away) session keeps its threads before they are released. */
  ownershipGraceMinutes: z.number().int().min(1).default(120),
});
