import { z } from 'zod';
import { IsoDate, ParticipantRef, Trust } from './primitives';

export const MessageKind = z.enum([
  'ask', // a question or request that expects an answer
  'reply', // an answer or status report inside an existing thread
  'broadcast', // an announcement to several participants
  'task', // task lifecycle notice (assigned, accepted, blocked, done…)
  'review', // review requested or submitted
  'plan', // planning-session traffic (invites, rounds, contributions, results)
  'escalation', // an agent asking a human
  'event', // an external event routed in by a rule
  'system', // hub notice
]);
export type MessageKind = z.infer<typeof MessageKind>;

/** Kinds a participant may send directly with `message.send`. */
export const SendableKind = z.enum(['ask', 'reply', 'broadcast']);
export type SendableKind = z.infer<typeof SendableKind>;

export const ReplyStatus = z.enum([
  'answer',
  'accepted',
  'declined',
  'working',
  'blocked',
  'done',
  'needs_human',
  'info',
]);
export type ReplyStatus = z.infer<typeof ReplyStatus>;

export const MessageRefs = z.object({
  taskId: z.string().optional(),
  planId: z.string().optional(),
  round: z.string().optional(),
  prUrl: z.string().optional(),
  replyTo: z.string().optional(),
  eventId: z.string().optional(),
  action: z.string().optional(),
  verdict: z.string().optional(),
});
export type MessageRefs = z.infer<typeof MessageRefs>;

/** The envelope delivered to every recipient and published on the activity feed. */
export const MeshMessage = z.object({
  id: z.string(),
  threadId: z.string(),
  kind: MessageKind,
  from: ParticipantRef,
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  status: ReplyStatus.nullable(),
  trust: Trust,
  depth: z.number().int().nonnegative(),
  refs: MessageRefs,
  createdAt: IsoDate,
});
export type MeshMessage = z.infer<typeof MeshMessage>;

export const ThreadKind = z.enum(['conversation', 'task', 'planning', 'escalation', 'event']);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const ThreadSummary = z.object({
  id: z.string(),
  kind: ThreadKind,
  subject: z.string(),
  createdBy: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  depth: z.number().int().nonnegative(),
  parentId: z.string().nullable(),
  participants: z.array(z.string()),
  taskId: z.string().nullable(),
  planId: z.string().nullable(),
  status: z.enum(['open', 'closed']),
  messageCount: z.number().int().nonnegative(),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;
