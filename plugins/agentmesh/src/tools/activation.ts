import { randomInt } from 'node:crypto';
import type { ChannelEvent } from '../inbox/render';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const VALID_MS = 10 * 60_000;

/**
 * The activation round trip. A code reaches Claude only through a channel
 * push, so a session that sends it back provably receives pushes. Also
 * remembers what this process was active as, to re-check after a renewal.
 */
export class ActivationCheck {
  #code: string | null = null;
  #issuedAt = 0;
  /** This session's description while it is active; null before activation and after deactivate. */
  lastDescription: string | null = null;

  /** A fresh code; earlier ones stop working. */
  issue(): string {
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]);
    this.#code = code.join('');
    this.#issuedAt = Date.now();
    return this.#code;
  }

  /** Accepts only the latest code, within 10 minutes of issuing it. */
  verify(code: string): boolean {
    return code === this.#code && Date.now() - this.#issuedAt <= VALID_MS;
  }
}

/**
 * The channel event that carries a code. `previous` is set when the hub gave
 * this process a new session after a long absence, and is suggested again.
 */
export function checkEvent(code: string, previous?: string): ChannelEvent {
  const intro = previous
    ? 'This session reconnected to the mesh after a long absence and is no longer active. '
    : '';
  const description = previous ?? '<one line: what this session is working on>';
  const outro = previous ? ' Write a new line instead if the focus changed.' : '';
  return {
    content: `${intro}AgentMesh activation check. Code: ${code}. To finish, call activate(code: "${code}", description: "${description}").${outro}`,
    meta: { kind: 'system', from: 'agentmesh' },
  };
}
