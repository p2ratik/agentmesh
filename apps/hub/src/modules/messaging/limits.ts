import { MeshError } from '@agentmesh/common';
import type { LimitsConfig } from '@agentmesh/config';

/** What the limits are checked against, gathered by the caller. */
export interface PostCounts {
  bodyChars: number;
  /** Non-hub messages in the thread during the last hour. */
  threadLastHour: number;
  /** The sender's messages in the last 24 hours. */
  senderLastDay: number;
  /** The same body from the same sender in the same thread inside the dedup window. */
  duplicate: boolean;
}

/** Cuts a body to `maxChars`, ending with a note that it was cut. Pure. */
export function clipBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const note = `\n… _(truncated to ${maxChars} characters)_`;
  return `${body.slice(0, Math.max(0, maxChars - note.length))}${note}`;
}

/** Returns the first limit a participant post breaks, or null. Pure. */
export function postLimitViolation(counts: PostCounts, limits: LimitsConfig): MeshError | null {
  if (counts.bodyChars > limits.maxBodyChars) {
    return new MeshError('invalid_request', `Message body exceeds ${limits.maxBodyChars} chars`, {
      limit: limits.maxBodyChars,
    });
  }
  if (counts.duplicate) {
    return new MeshError(
      'duplicate',
      `You already sent this message to this thread in the last ${limits.dedupWindowSeconds}s`,
    );
  }
  if (counts.threadLastHour >= limits.perThreadPerHour) {
    return new MeshError(
      'rate_limited',
      `Thread limit reached: ${limits.perThreadPerHour} messages per hour`,
      { limit: limits.perThreadPerHour, window: 'hour' },
    );
  }
  if (counts.senderLastDay >= limits.perSenderPerDay) {
    return new MeshError(
      'rate_limited',
      `Sender limit reached: ${limits.perSenderPerDay} messages per day`,
      { limit: limits.perSenderPerDay, window: 'day' },
    );
  }
  return null;
}
