import { ulid } from 'ulid';

/**
 * Identifier conventions:
 * - Messages and events use time-sortable ULIDs (`msg-01J…`, `evt-01J…`).
 * - Threads, tasks and plans use short sequential ids humans can type in Discord
 *   (`thr-12`, `task-42`, `plan-7`).
 */
export const ID_PREFIX = {
  message: 'msg',
  event: 'evt',
  thread: 'thr',
  task: 'task',
  plan: 'plan',
} as const;

export type SequentialKind = 'thread' | 'task' | 'plan';

export const newMessageId = (): string => `${ID_PREFIX.message}-${ulid()}`;
export const newEventId = (): string => `${ID_PREFIX.event}-${ulid()}`;

const SESSION_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Hub-issued session id: `s-` plus 12 random `[a-z0-9]` (matches the protocol's pattern). */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `s-${Array.from(bytes, (b) => SESSION_ALPHABET[b % SESSION_ALPHABET.length]).join('')}`;
}

export function formatId(kind: SequentialKind, n: number): string {
  return `${ID_PREFIX[kind]}-${n}`;
}

/** Accepts `task-42`, `TASK-42` or a bare `42`; returns null for anything else. */
export function parseId(kind: SequentialKind, raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  const prefix = `${ID_PREFIX[kind]}-`;
  const digits = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Participant ids double as NATS subject tokens, so they must stay this strict. */
export const PARTICIPANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidParticipantId(id: string): boolean {
  return PARTICIPANT_ID_PATTERN.test(id);
}

/** Turns free text into a git-branch-safe slug. */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'task';
}
