import { isAtLeast, RELAY_MIN_VERSION } from '@agentmesh/common/version';
import type { SessionDelivery } from '@agentmesh/protocol';
import { internalId } from '../../core/ids';
import { toRouteSession } from './mappers';
import { longestActive, type RouteSession, ready } from './routing';
import type { SessionsRepo } from './sessions.repo';

export interface RelayInput {
  message: Pick<SessionDelivery, 'kind' | 'trust' | 'class' | 'from'>;
  /** The session that owns the message's thread itself (not its parent's or task's owner). */
  threadOwner: string | null;
  /** The agent's non-closed sessions. */
  sessions: RouteSession[];
}

export interface RelayTarget {
  windowId: string;
  forSession: string;
  reason: string;
}

/**
 * Whether a waiting message wakes its private asker through the mesh window (spec §4.1): an
 * action reply from a teammate or a human, not external, for a thread whose direct owner is
 * inactive and live, with a ready push mesh window on RELAY_MIN_VERSION or later (the
 * longest-active one). Pure.
 */
export function relayTarget({ message, threadOwner, sessions }: RelayInput): RelayTarget | null {
  const { kind, class: cls, trust, from } = message;
  if (kind !== 'reply' || cls !== 'action' || trust === 'external') return null;
  if (from.kind !== 'agent' && from.kind !== 'human') return null;
  const owner = sessions.find((s) => s.id === threadOwner);
  if (!owner || owner.active || owner.liveness !== 'live') return null;
  const windows = sessions.filter(
    (s) => s.meshWindow && ready(s) && isAtLeast(s.clientVersion, RELAY_MIN_VERSION),
  );
  const win = longestActive(windows);
  if (!win) return null;
  return {
    windowId: win.id,
    forSession: owner.id,
    reason: `relay to ${win.id} for inactive ${owner.id}`,
  };
}

/** `relayTarget` over the agent's sessions and the thread's direct owner, as stored now. */
export function relayFor(
  repo: SessionsRepo,
  agentId: string,
  message: SessionDelivery,
): RelayTarget | null {
  return relayTarget({
    message,
    threadOwner: repo.owner(internalId('thread', message.threadId), agentId),
    sessions: repo.listLive(agentId).map(toRouteSession),
  });
}

const markKey = (agentId: string, threadId: string) => `${agentId} ${threadId}`;

/**
 * The pointers sent per (agent, thread, asking session), so the window is told once until the
 * owner reads the thread.
 */
// ponytail: in memory; a hub restart may send one duplicate pointer per pending thread (the read is idempotent). A table if that ever matters.
export class RelayMarks {
  readonly #sent = new Map<string, Set<string>>();

  has(agentId: string, threadId: string, sessionId: string): boolean {
    return this.#sent.get(markKey(agentId, threadId))?.has(sessionId) ?? false;
  }

  set(agentId: string, threadId: string, sessionId: string): void {
    const key = markKey(agentId, threadId);
    this.#sent.set(key, (this.#sent.get(key) ?? new Set()).add(sessionId));
  }

  /** One session's mark only: its request failed, so the next flush sends it again. */
  delete(agentId: string, threadId: string, sessionId: string): void {
    this.#sent.get(markKey(agentId, threadId))?.delete(sessionId);
  }

  clearThread(agentId: string, threadId: string): void {
    this.#sent.delete(markKey(agentId, threadId));
  }
}
