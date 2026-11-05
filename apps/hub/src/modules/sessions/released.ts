import type { SessionDelivery } from '@agentmesh/protocol';
import type { Route } from './routing';

/** The dispatcher's routes within one flush, and the `released` marker they carry. Pure. */

/** The message as its session gets it: marked when its route says the private asker closed. */
export function withReleased(
  message: SessionDelivery,
  route: Extract<Route, { kind: 'deliver' }>,
): SessionDelivery {
  return route.released ? { ...message, released: route.released } : message;
}

/**
 * A later message of a thread, in the same call, goes where the thread's first
 * one went, with its claim and marker: only action items claim, so a status
 * first message leaves the claim to a later action.
 */
export function follow(first: Route): Route {
  if (first.kind === 'wait')
    return { kind: 'wait', reason: 'an earlier message of its thread waits' };
  const { sessionId, claim, released } = first;
  const reason = `its thread goes to ${sessionId} in this batch`;
  return { kind: 'deliver', sessionId, claim, reason, ...(released && { released }) };
}
