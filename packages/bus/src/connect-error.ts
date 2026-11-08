import { MeshError } from '@agentmesh/common';

/** What to tell the person when the hub refused, and when it can't be told apart from a drop. */
export interface ConnectWords {
  /** The hub refused the credentials (`Authorization Violation`). */
  refused: string;
  /** A reset or a timeout during the connect: a refusal, or the network failing. */
  dropped: string;
}

/** An error's name, message and code, and its causes' (nats.js keeps `ECONNREFUSED` in the cause). */
function described(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return error === undefined ? '' : String(error);
  const { code } = error as { code?: unknown };
  const own = `${error.name} ${error.message} ${typeof code === 'string' ? code : ''}`;
  return depth < 3 ? `${own} ${described(error.cause, depth + 1)}` : own;
}

/**
 * Maps a failed `connectOnce` without echoing the server's text. A refusal arrives as
 * `Authorization Violation` or as a reset (NATS closes on a refusal, and on Windows the reset can
 * come before its -ERR is read); a reset or a timeout can also be the network, so it gets
 * `words.dropped` and the caller's `details`. TLS and unreachable hubs get fixed words.
 */
export function refusedOrUnreachable(
  error: unknown,
  hub: string,
  words: ConnectWords,
  details?: Record<string, unknown>,
): MeshError {
  const text = described(error);
  if (/authori[sz]ation/i.test(text)) return new MeshError('unauthenticated', words.refused);
  if (/tls/i.test(text)) {
    return new MeshError(
      'unavailable',
      `${hub} did not offer TLS, so nothing was sent. Check the hub URL with your admin.`,
    );
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return new MeshError(
      'unavailable',
      `Could not reach the hub at ${hub}. Check your network and try again.`,
    );
  }
  return new MeshError('unauthenticated', words.dropped, details);
}
