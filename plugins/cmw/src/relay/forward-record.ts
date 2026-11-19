// Built-ins only (the guard bundle reads these records). The file name holds only the 32-hex part
// of an address, never the address, and the record holds only the pointer's fields.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_ID, type PointerFields, pointerText } from './pointer';

/**
 * How long the window's guard will pass a pushed pointer. Claude Code holds a push until the
 * window can take it, which can be hours (a console frozen by a text selection, a long turn), and
 * nothing pushes it again. The pointer is fixed text to a fixed address, once, so a longer life
 * adds no reach.
 */
export const FORWARD_TTL_MS = 24 * 3_600_000;

const HEX = /^[0-9a-f]{32}$/;

/** The record's file name, or null for a hex or message id outside its pattern. */
export function forwardFile(hex: string, messageId: string): string | null {
  return HEX.test(hex) && MESSAGE_ID.test(messageId) ? `fwd-${hex}-${messageId}.json` : null;
}

/**
 * The mesh window's note to its guard: it pushed this pointer, to forward to the address whose
 * 32-hex part names the file, until `expiresAt`. The guard passes one exact SendMessage per record.
 */
export function writeForward(
  dir: string,
  hex: string,
  fields: PointerFields,
  expiresAt: number,
): void {
  const name = forwardFile(hex, fields.messageId);
  if (!name || !pointerText(fields)) throw new Error('refusing to write an invalid forward record');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneClaimed(dir, Date.now());
  const file = join(dir, name);
  const { from, threadId, messageId } = fields;
  // Write then rename, so the guard never reads half a file.
  const staged = `${file}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify({ from, threadId, messageId, expiresAt }), { mode: 0o600 });
  renameSync(staged, file);
}

export interface ForwardCandidate {
  name: string;
  fields: PointerFields;
}

/**
 * One record's fields, if it is unexpired (and expires within the TTL), valid, and its name agrees
 * with its content.
 */
function candidate(dir: string, name: string, hex: string, now: number): ForwardCandidate[] {
  try {
    const v = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
    const fields = { from: v.from, threadId: v.threadId, messageId: v.messageId } as PointerFields;
    const ok =
      typeof v.expiresAt === 'number' &&
      now <= v.expiresAt &&
      // Nothing in the file is trusted: a hand-written far-future expiry must not live forever.
      v.expiresAt - now <= FORWARD_TTL_MS &&
      pointerText(fields) !== null &&
      forwardFile(hex, fields.messageId) === name;
    return ok ? [{ name, fields }] : [];
  } catch {
    return [];
  }
}

/** The unexpired, valid records for the address whose 32-hex part is `hex`. */
export function readForwards(dir: string, hex: string, now: number): ForwardCandidate[] {
  if (!HEX.test(hex)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // ponytail: expired records stay until claimed or removed; sweep them if they ever pile up.
  // Only `.json` names: a `.claimed` marker is never read as a record.
  return names
    .filter((n) => n.startsWith(`fwd-${hex}-`) && n.endsWith('.json'))
    .flatMap((n) => candidate(dir, n, hex, now));
}

const CLAIMED = '.claimed';

/**
 * Takes a record for one send. Creating its `.claimed` marker is exclusive, so exactly one caller
 * wins; a rename is not on Windows (it opens the source by name, then renames through the handle).
 * The marker stays, so a caller that read the record before it was removed can't claim it again,
 * and a record the window removed first can't be claimed at all.
 */
export function claimForward(dir: string, name: string): boolean {
  try {
    closeSync(openSync(join(dir, `${name}${CLAIMED}`), 'wx', 0o600));
  } catch {
    return false;
  }
  if (!existsSync(join(dir, name))) return false;
  removeForward(dir, name);
  return true;
}

/** Whether this pointer was pushed already: its record was claimed, or is still unexpired. */
export function forwardedBefore(dir: string, hex: string, name: string, now: number): boolean {
  if (existsSync(join(dir, `${name}${CLAIMED}`))) return true;
  return readForwards(dir, hex, now).some((c) => c.name === name);
}

/** Drops the window's claim markers older than the TTL, best effort: no live record needs them. */
function pruneClaimed(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names.filter((f) => f.startsWith('fwd-') && f.endsWith(CLAIMED))) {
    try {
      if (now - statSync(join(dir, n)).mtimeMs > FORWARD_TTL_MS) removeForward(dir, n);
    } catch {
      // Gone already, or unreadable: a later write tries again. The write itself never fails here.
    }
  }
}

/** Removes a record; a file that is already gone, or busy, is left to expire. */
export function removeForward(dir: string, name: string): void {
  try {
    rmSync(join(dir, name), { force: true });
  } catch {
    // A leftover `.claimed` marker is never read as a record; a leftover record expires.
  }
}

/**
 * Takes each record that expired unclaimed (the guard never passed its send), so the caller
 * reports it once: taking is `claimForward`, which only one caller wins, and it removes the record.
 */
export function sweepExpired(dir: string, now: number): PointerFields[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const swept: PointerFields[] = [];
  for (const name of names.filter((n) => n.startsWith('fwd-') && n.endsWith('.json'))) {
    try {
      const v = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      const fields = {
        from: v.from,
        threadId: v.threadId,
        messageId: v.messageId,
      } as PointerFields;
      const hex = name.slice(4, 36);
      const valid = forwardFile(hex, fields.messageId) === name && pointerText(fields) !== null;
      if (
        valid &&
        typeof v.expiresAt === 'number' &&
        now > v.expiresAt &&
        claimForward(dir, name)
      ) {
        // The pointer never went out: drop the marker too, so a hub resend is forwarded normally.
        removeForward(dir, `${name}${CLAIMED}`);
        swept.push(fields);
      }
    } catch {
      // Unreadable or half-written: left for a later sweep.
    }
  }
  return swept;
}
