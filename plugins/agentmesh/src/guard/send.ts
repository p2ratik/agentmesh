// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. The one SendMessage the
// mesh window may make: the reply pointer the plugin pushed, to the address it named, once.
import type { ReasonCode } from '@agentmesh/protocol/observe-codes';
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

/**
 * SendMessage's fields; Claude Code fills `recipient`, `recipient_kind` and `content` itself. The
 * model fills `summary`, a label for its own transcript row that is never transmitted.
 */
const KEYS = new Set([
  'to',
  'recipient',
  'recipient_kind',
  'message',
  'content',
  'type',
  'summary',
]);
const SUMMARY_MAX = 200;
/** A key name the timeline may keep: a plain identifier, never text the model wrote. */
const KEY_NAME = /^[A-Za-z_]{1,40}$/;

/** Every refusal says the same to Claude; the code says which check failed. */
const denied = (code: ReasonCode, key?: string): GuardDecision => ({
  kind: 'deny',
  reason: SEND_DENIED,
  code,
  ...(key !== undefined && KEY_NAME.test(key) ? { key } : {}),
});

const shortLabel = (v: unknown) =>
  v === undefined || (typeof v === 'string' && v.length <= SUMMARY_MAX);

/** Claude Code's `content`: the message itself, or a shorter preview of it ending in "…". */
const contentOf = (content: unknown, message: string) =>
  content === message ||
  (typeof content === 'string' &&
    content.endsWith('…') &&
    content.length < message.length &&
    message.startsWith(content.slice(0, -1)));

/**
 * Passes one SendMessage only when it is exactly a pointer the plugin recorded for that address,
 * and claims the record so a replay is refused. The text is rebuilt from the record's fields with
 * pointerText, never taken from the file, and the address is checked before any file is read.
 */
export function sendMessage(args: Record<string, unknown>, ctx: GuardContext): GuardDecision {
  const unknown = Object.keys(args).find((k) => !KEYS.has(k));
  if (unknown !== undefined) return denied('send.unknown_key', unknown);
  const hex = udsHex(args.to, ctx.platform);
  if (hex === null) return denied('send.bad_address');
  const { message } = args;
  const aliases =
    args.recipient === args.to &&
    args.type === 'message' &&
    (args.recipient_kind === undefined || typeof args.recipient_kind === 'string');
  if (!aliases || typeof message !== 'string') return denied('send.alias_mismatch');
  if (!contentOf(args.content, message)) return denied('send.content_mismatch');
  if (!shortLabel(args.summary)) return denied('send.bad_summary');
  if (!ctx.forwards) return denied('send.no_record');
  const record = ctx.forwards
    .read(hex, ctx.now ?? Date.now())
    .find((c) => pointerText(c.fields) === message);
  if (!record) return denied('send.no_record');
  if (!ctx.forwards.claim(record.name)) return denied('send.claim_failed');
  // The ids come from the record's fields, which pointerText validated.
  const { messageId, threadId } = record.fields;
  return { kind: 'pass', claimed: { message: messageId, thread: threadId } };
}
