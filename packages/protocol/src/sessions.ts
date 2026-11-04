import { z } from 'zod';
import { DeliveryClass, MeshMessage } from './messages';
import { ClaudeSessionId, DeliveryMode, IsoDate, ParticipantId, SessionId } from './primitives';

// SessionId, SESSION_ID_PATTERN, DeliveryMode and SessionSummary live in primitives.ts (PeerInfo needs them).
export { SESSION_ID_PATTERN, SessionId, SessionSummary } from './primitives';

/** One Claude Code session of an agent, as the hub tracks it. `owns` holds thread keys (`thr-3`). */
export const SessionView = z.object({
  id: SessionId,
  active: z.boolean(),
  delivery: DeliveryMode.default('push'),
  description: z.string().nullable(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  owns: z.array(z.string()),
});
export type SessionView = z.infer<typeof SessionView>;

/** Most messages in one `deliver`; the hub splits bigger batches. */
export const MAX_DELIVERY_MESSAGES = 100;

/**
 * How long a reply whose private asker closed waits in the mesh window for the owner's decision
 * before the hub pings them (`relay.closedAskerEscalationMinutes`).
 */
export const CLOSED_ASKER_DEFAULT_MINUTES = 15;

/**
 * On a delivery to a mesh window (0.6.0 and later): the thread's private asker `bySession` closed
 * at `closedAt` and released it, so the window asks its human what to do with the answer.
 * `claudeSessionId` lets the window print `claude --resume <uuid>`.
 */
export const ReleasedMarker = z.object({
  bySession: SessionId,
  closedAt: IsoDate,
  claudeSessionId: ClaudeSessionId.nullable(),
});
export type ReleasedMarker = z.infer<typeof ReleasedMarker>;

/** A message as delivered to one recipient, with its class for that recipient. */
export const SessionDelivery = MeshMessage.extend({
  class: DeliveryClass.default('action'),
  released: ReleasedMarker.optional(),
});
export type SessionDelivery = z.infer<typeof SessionDelivery>;

/**
 * A pointer for the mesh window (0.6.0 and later): a reply from `from` waits in `threadId` for the
 * agent's inactive private session `forSession`. It carries no body; the hub keeps the reply
 * pending until that session reads it.
 */
export const SessionRelay = z.object({
  type: z.literal('relay'),
  threadId: z.string().regex(/^thr-\d{1,12}$/),
  messageId: z.string().regex(/^msg-[0-9A-HJKMNP-TV-Z]{26}$/),
  from: ParticipantId,
  forSession: SessionId,
});
export type SessionRelay = z.infer<typeof SessionRelay>;

/**
 * What the hub publishes on `{p}.session.{agent}.{session}`. `deliver`, `check` and `relay` are
 * requests the plugin acks; `check` carries the activation code for Claude to send back.
 */
export const SessionInbound = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('deliver'),
    messages: z.array(SessionDelivery).min(1).max(MAX_DELIVERY_MESSAGES),
  }),
  z.object({ type: z.literal('expired') }),
  z.object({ type: z.literal('check'), code: z.string().min(1).max(20) }),
  SessionRelay,
]);
export type SessionInbound = z.infer<typeof SessionInbound>;

/**
 * Reply to a session request: ids of the messages the session took (empty for a `check` or a
 * `relay`). A relay's ack also says whether the window forwarded the pointer, and why.
 */
export const SessionAck = z.object({
  delivered: z.array(z.string()),
  forwarded: z.boolean().optional(),
  reason: z.string().max(200).optional(),
});
export type SessionAck = z.infer<typeof SessionAck>;

/** A relay's ack as the hub reads it. */
export interface RelayAnswer {
  forwarded: boolean;
  reason: string;
}
