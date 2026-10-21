import { randomInt } from 'node:crypto';
import { MeshError } from '@agentmesh/common';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const VALID_MS = 10 * 60_000;

/**
 * Activation check codes, one per session (spec §3): the hub sends the session a
 * code over its session subject, and the session goes live only when its Claude
 * sends the code back, which proves both the NATS leg and the channel push.
 * ponytail: in memory, so a hub restart means asking for a new check.
 */
export class ActivationChecks {
  readonly #codes = new Map<string, { code: string; at: number }>();

  /** A fresh code for the session; it replaces any earlier one. */
  issue(sessionId: string, now: number): string {
    for (const [id, issued] of this.#codes) if (now - issued.at > VALID_MS) this.#codes.delete(id);
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]);
    this.#codes.set(sessionId, { code: code.join(''), at: now });
    return code.join('');
  }

  /** Throws unless `code` (trimmed, any case) is the session's latest, at most 10 minutes old. */
  confirm(sessionId: string, code: string, now: number): void {
    const issued = this.#codes.get(sessionId);
    if (!issued || issued.code !== code.trim().toUpperCase() || now - issued.at > VALID_MS) {
      throw new MeshError(
        'invalid_request',
        'That code is wrong or stale. Call activate without a code for a new test message.',
      );
    }
  }
}
