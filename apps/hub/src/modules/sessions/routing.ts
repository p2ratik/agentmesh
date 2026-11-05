/** Pure per-session delivery routing (spec §3). No I/O. */

import { isAtLeast, RELAY_MIN_VERSION } from '@agentmesh/common/version';
import type { ReleasedMarker } from '@agentmesh/protocol';

export interface RouteSession {
  id: string;
  active: boolean;
  liveness: 'live' | 'away';
  /** A `pull` session is never delivered to: it reads its messages with `inbox`. */
  delivery: 'push' | 'pull';
  repo: string | null;
  activatedAt: string | null;
  /** Started by the mesh window launcher: team work goes here first. */
  meshWindow: boolean;
  /** The plugin version its hello reported. */
  clientVersion: string;
}

export interface RouteInput {
  /** The agent's non-closed sessions. */
  sessions: RouteSession[];
  /** Session owning the message's thread (for this agent). */
  threadOwner: string | null;
  /** Owner of the thread's parent. */
  parentOwner: string | null;
  /** Owner of refs.taskId's thread, when it differs. */
  taskOwner: string | null;
  /** refs.session. */
  picked: string | null;
  /** refs.repo, else the task's repo. */
  repo: string | null;
  /** Set only for an unowned thread whose latest releaser was a closed private session. */
  released: ReleasedMarker | null;
}

export type Route =
  | {
      kind: 'deliver';
      sessionId: string;
      claim: boolean;
      reason: string;
      /** For a 0.6.0 mesh window: the thread's private asker closed. */
      released?: ReleasedMarker;
    }
  | { kind: 'wait'; reason: string };

/** A delivery target: active, live and push (a pull session reads its own messages). */
export const ready = (s: RouteSession): boolean =>
  s.active && s.liveness === 'live' && s.delivery === 'push';

/** Why a session that holds work cannot take a delivery now. */
const notReady = (s: RouteSession): string =>
  !s.active ? 'inactive' : s.liveness === 'away' ? 'away' : 'pull';

/** Earliest activation first; ties keep list order. */
export const longestActive = (list: RouteSession[]): RouteSession | undefined =>
  list.reduce<RouteSession | undefined>(
    (best, s) => (!best || (s.activatedAt ?? '') < (best.activatedAt ?? '') ? s : best),
    undefined,
  );

const ownerChain = (input: RouteInput) => [
  { id: input.threadOwner, claim: false, reason: 'owns thread' },
  { id: input.parentOwner, claim: true, reason: 'owns parent thread' },
  { id: input.taskOwner, claim: true, reason: 'owns task' },
];

/** The first parent/task owner that is listed but inactive, so it does not hold the work. */
function skippedOwner(input: RouteInput): string | undefined {
  for (const o of ownerChain(input)) {
    const session = input.sessions.find((s) => s.id === o.id);
    if (session && o.claim && !session.active)
      return `; skipped inactive ${session.id} (${o.reason})`;
  }
  return undefined;
}

/** The first open owner in the chain: the thread's, its parent's, then its task's. */
export function chainOwner(
  input: RouteInput,
): { session: RouteSession; claim: boolean; reason: string } | undefined {
  for (const o of ownerChain(input)) {
    const session = input.sessions.find((s) => s.id === o.id); // a closed owner is not listed
    // an inactive parent/task owner does not hold work (a private session owns only its conversations)
    if (session && (!o.claim || session.active))
      return { session, claim: o.claim, reason: o.reason };
  }
  return undefined;
}

export function routeDelivery(input: RouteInput): Route {
  const owner = chainOwner(input);
  if (owner) {
    const { session, claim, reason } = owner;
    if (ready(session)) return { kind: 'deliver', sessionId: session.id, claim, reason };
    return {
      kind: 'wait',
      reason: `held for ${session.id} (${notReady(session)})`,
    };
  }

  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const picked = input.picked ? byId.get(input.picked) : undefined;
  if (picked && ready(picked)) {
    return { kind: 'deliver', sessionId: picked.id, claim: true, reason: 'picked by sender' };
  }
  // The sender chose that window on purpose: a live pull pick reads it itself; nobody else takes it.
  if (picked?.active && picked.liveness === 'live' && picked.delivery === 'pull') {
    return { kind: 'wait', reason: `held for ${picked.id} (picked, pull)` };
  }

  const route = fallThrough(input.sessions.filter(ready), input);
  return { ...route, reason: route.reason + (skippedOwner(input) ?? '') };
}

/** Unowned work: the mesh window, then the task's repo, then the longest-active session. */
function fallThrough(candidates: RouteSession[], { repo, released }: RouteInput): Route {
  const win = longestActive(candidates.filter((s) => s.meshWindow));
  // The longest-active window, at 0.6.0+, leaves a closed private asker's thread for it to reclaim.
  if (win && released && isAtLeast(win.clientVersion, RELAY_MIN_VERSION)) {
    const reason = `released by closed ${released.bySession}`;
    return { kind: 'deliver', sessionId: win.id, claim: false, reason, released };
  }
  if (win) return { kind: 'deliver', sessionId: win.id, claim: true, reason: 'mesh window' };
  const inRepo = repo ? longestActive(candidates.filter((s) => s.repo === repo)) : undefined;
  if (inRepo) {
    return { kind: 'deliver', sessionId: inRepo.id, claim: true, reason: `in repo ${repo}` };
  }
  const any = longestActive(candidates);
  if (any) {
    return { kind: 'deliver', sessionId: any.id, claim: true, reason: 'longest-active session' };
  }
  return { kind: 'wait', reason: 'no active push session' };
}
