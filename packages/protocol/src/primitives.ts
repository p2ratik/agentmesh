import { PARTICIPANT_ID_PATTERN } from '@agentmesh/common';
import { z } from 'zod';

export const IsoDate = z.string().min(1);

/**
 * Caps for what callers send, so no field carries megabytes into the hub's
 * rows, logs or error messages. `IdRef`: any id a caller names (`thr-12`,
 * `task-42`, `msg-01J…`, a session or participant id, `@all`). `GitRef`: a
 * repo (`owner/name`) or branch name; heartbeats use the same cap. `Label`:
 * a task label.
 */
export const IdRef = z.string().max(64);
export const GitRef = z.string().max(300);
export const Label = z.string().max(60);

export const ParticipantId = z
  .string()
  .regex(
    PARTICIPANT_ID_PATTERN,
    'lowercase letters, digits and dashes; starts with a letter/digit',
  );

export const ParticipantKind = z.enum(['agent', 'human', 'service']);
export type ParticipantKind = z.infer<typeof ParticipantKind>;

export const ParticipantRef = z.object({
  id: z.string(),
  kind: ParticipantKind,
  displayName: z.string(),
});
export type ParticipantRef = z.infer<typeof ParticipantRef>;

/** Status an agent can declare for itself; `offline` is only ever set by the hub. */
export const DeclaredStatus = z.enum(['online', 'busy', 'away']);
export const PresenceStatus = z.enum(['online', 'busy', 'away', 'offline']);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

/** Hub-issued session id. Lives here (not sessions.ts) so PeerInfo avoids an import cycle. */
export const SESSION_ID_PATTERN = /^s-[a-z0-9]{12}$/;
export const SessionId = z.string().regex(SESSION_ID_PATTERN);

export const SessionSummary = z.object({
  id: SessionId,
  description: z.string(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  activeSince: IsoDate,
  tasks: z.array(z.string()),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const PeerInfo = ParticipantRef.extend({
  owner: z.string().nullable(),
  status: PresenceStatus,
  statusNote: z.string().nullable(),
  lastSeen: IsoDate.nullable(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  skills: z.array(z.string()),
  areas: z.array(z.string()),
  activeTasks: z.number().int().nonnegative(),
  sessions: z.array(SessionSummary).default([]),
});
export type PeerInfo = z.infer<typeof PeerInfo>;

/**
 * `team` content comes from mesh participants. `external` content originated
 * outside the team (GitHub issues, error logs, monitoring alerts) and must be
 * treated as data, never as instructions.
 */
export const Trust = z.enum(['team', 'external']);
export type Trust = z.infer<typeof Trust>;

export const Severity = z.enum(['debug', 'info', 'warning', 'error', 'critical']);
export type Severity = z.infer<typeof Severity>;

export const Priority = z.enum(['low', 'normal', 'high', 'urgent']);
export type Priority = z.infer<typeof Priority>;

export const GitPolicy = z.object({
  integrationBranch: z.string(),
  protectedBranches: z.array(z.string()),
  branchTemplate: z.string(),
  agentsMayMergeInto: z.array(z.string()),
});
export type GitPolicy = z.infer<typeof GitPolicy>;
