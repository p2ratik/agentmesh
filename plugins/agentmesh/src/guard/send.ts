// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. The one SendMessage the
// mesh window may make: the reply pointer the plugin pushed, to the address it named, once.
import { udsHex } from '../relay/address';
import { claimForward, type ForwardCandidate, readForwards } from '../relay/forward-record';
import { pointerText } from '../relay/pointer';
import type { GuardContext, GuardDecision } from './decide';

export const SEND_DENIED =
  'mesh window: SendMessage may only forward the reply pointer the plugin pushed (meta forward_to), exactly as pushed, once';
export const LIST_AGENTS =
  'mesh window: ListAgents is refused here; the plugin gives the address to send to';

/** The window's forward records, as the guard sees them. */
export interface ForwardReader {
  read(hex: string, now: number): ForwardCandidate[];
  claim(name: string): boolean;
}

/** The records in the window's data folder (MeshWindowContext.dataDir). */
export const forwardReader = (dir: string): ForwardReader => ({
  read: (hex, now) => readForwards(dir, hex, now),
  claim: (name) => claimForward(dir, name),
});

/** SendMessage's fields; Claude Code fills `recipient`, `recipient_kind` and `content` itself. */
const KEYS = new Set(['to', 'recipient', 'recipient_kind', 'message', 'content', 'type']);
const DENIED: GuardDecision = { kind: 'deny', reason: SEND_DENIED };

/**
 * Passes one SendMessage only when it is exactly a pointer the plugin recorded for that address,
 * and claims the record so a replay is refused. The text is rebuilt from the record's fields with
 * pointerText, never taken from the file, and the address is checked before any file is read.
 */
export function sendMessage(args: Record<string, unknown>, ctx: GuardContext): GuardDecision {
  if (!Object.keys(args).every((k) => KEYS.has(k))) return DENIED;
  const hex = udsHex(args.to, ctx.platform);
  if (hex === null) return DENIED;
  const aliases =
    args.recipient === args.to &&
    args.type === 'message' &&
    (args.recipient_kind === undefined || typeof args.recipient_kind === 'string') &&
    typeof args.message === 'string' &&
    args.content === args.message;
  if (!aliases || !ctx.forwards) return DENIED;
  const record = ctx.forwards
    .read(hex, ctx.now ?? Date.now())
    .find((c) => pointerText(c.fields) === args.message);
  return record && ctx.forwards.claim(record.name) ? { kind: 'pass' } : DENIED;
}
