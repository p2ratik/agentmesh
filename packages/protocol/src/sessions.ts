import { z } from 'zod';
import { MeshMessage } from './messages';
import { SessionId } from './primitives';

// SessionId, SESSION_ID_PATTERN and SessionSummary live in primitives.ts (PeerInfo needs them).
export { SESSION_ID_PATTERN, SessionId, SessionSummary } from './primitives';

/** One Claude Code session of an agent, as the hub tracks it. `owns` holds thread keys (`thr-3`). */
export const SessionView = z.object({
  id: SessionId,
  active: z.boolean(),
  description: z.string().nullable(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  owns: z.array(z.string()),
});
export type SessionView = z.infer<typeof SessionView>;

/** Most messages in one `deliver`; the hub splits bigger batches. */
export const MAX_DELIVERY_MESSAGES = 100;

/**
 * What the hub publishes on `{p}.session.{agent}.{session}`. `deliver` and `check` are
 * requests the plugin acks; `check` carries the activation code for Claude to send back.
 */
export const SessionInbound = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('deliver'),
    messages: z.array(MeshMessage).min(1).max(MAX_DELIVERY_MESSAGES),
  }),
  z.object({ type: z.literal('expired') }),
  z.object({ type: z.literal('check'), code: z.string().min(1).max(20) }),
]);
export type SessionInbound = z.infer<typeof SessionInbound>;

/** Reply to a `deliver` batch: ids of the messages the session took (empty for a `check`). */
export const SessionAck = z.object({ delivered: z.array(z.string()) });
export type SessionAck = z.infer<typeof SessionAck>;
