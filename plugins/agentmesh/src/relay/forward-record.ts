// Built-ins only (the guard bundle reads these records). The file name holds only the 32-hex part
// of an address, never the address, and the record holds only the pointer's fields.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_ID, type PointerFields, pointerText } from './pointer';

/** How long the window's guard will pass a pushed pointer. */
export const FORWARD_TTL_MS = 600_000;

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

/** One record's fields, if it is unexpired, valid, and its name agrees with its content. */
function candidate(dir: string, name: string, hex: string, now: number): ForwardCandidate[] {
  try {
    const v = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
    const fields = { from: v.from, threadId: v.threadId, messageId: v.messageId } as PointerFields;
    const ok =
      typeof v.expiresAt === 'number' &&
      now <= v.expiresAt &&
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
  return names
    .filter((n) => n.startsWith(`fwd-${hex}-`) && n.endsWith('.json'))
    .flatMap((n) => candidate(dir, n, hex, now));
}

/** Takes a record for one send: the rename succeeds for exactly one caller. */
export function claimForward(dir: string, name: string): boolean {
  const file = join(dir, name);
  const claimed = `${file}.${process.pid}.claimed`;
  try {
    renameSync(file, claimed);
  } catch {
    return false;
  }
  removeForward(dir, `${name}.${process.pid}.claimed`);
  return true;
}

/** Removes a record; a file that is already gone, or busy, is left to expire. */
export function removeForward(dir: string, name: string): void {
  try {
    rmSync(join(dir, name), { force: true });
  } catch {
    // A leftover `.claimed` file is never read again; a leftover record expires.
  }
}
