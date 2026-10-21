/** Pure per-session delivery routing (spec §3). No I/O. */

export interface RouteSession {
  id: string;
  active: boolean;
  liveness: 'live' | 'away';
  repo: string | null;
  activatedAt: string | null;
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
}

export type Route =
  | { kind: 'deliver'; sessionId: string; claim: boolean; reason: string }
  | { kind: 'wait'; reason: string };

const ready = (s: RouteSession): boolean => s.active && s.liveness === 'live';

/** Earliest activation first; ties keep list order. */
const longestActive = (list: RouteSession[]): RouteSession | undefined =>
  list.reduce<RouteSession | undefined>(
    (best, s) => (!best || (s.activatedAt ?? '') < (best.activatedAt ?? '') ? s : best),
    undefined,
  );

export function routeDelivery(input: RouteInput): Route {
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const owners = [
    { id: input.threadOwner, claim: false, reason: 'owns thread' },
    { id: input.parentOwner, claim: true, reason: 'owns parent thread' },
    { id: input.taskOwner, claim: true, reason: 'owns task' },
  ];
  for (const o of owners) {
    const session = o.id ? byId.get(o.id) : undefined; // a closed owner is not listed: ignored
    if (!session) continue;
    if (ready(session)) {
      return { kind: 'deliver', sessionId: session.id, claim: o.claim, reason: o.reason };
    }
    return {
      kind: 'wait',
      reason: `held for ${session.id} (${session.active ? 'away' : 'inactive'})`,
    };
  }

  const picked = input.picked ? byId.get(input.picked) : undefined;
  if (picked && ready(picked)) {
    return { kind: 'deliver', sessionId: picked.id, claim: true, reason: 'picked by sender' };
  }

  const candidates = input.sessions.filter(ready);
  const inRepo = input.repo
    ? longestActive(candidates.filter((s) => s.repo === input.repo))
    : undefined;
  if (inRepo) {
    return { kind: 'deliver', sessionId: inRepo.id, claim: true, reason: `in repo ${input.repo}` };
  }
  const any = longestActive(candidates);
  if (any) {
    return { kind: 'deliver', sessionId: any.id, claim: true, reason: 'longest-active session' };
  }
  return { kind: 'wait', reason: 'no active session' };
}
