import type { RpcMethodName } from '@agentmesh/protocol';
import type { CallContext } from '../../contracts';
import { claimsWhenInactive, claimTargets } from './claims';
import { claimedThread, claimThread } from './ownership';
import type { SessionsRepo } from './sessions.repo';
import type { SessionsDeps } from './sessions.service';

/** Agent callers with a verified session only. Never moves work another open session owns. */
export function recordClaims(
  repo: SessionsRepo,
  deps: SessionsDeps,
  at: string,
  call: CallContext,
  method: RpcMethodName,
  params: unknown,
  result: unknown,
): void {
  const { session: sessionId } = call;
  if (call.caller.kind !== 'agent' || !sessionId) return;
  const inactive = repo.get(sessionId)?.active !== 1;
  for (const target of claimTargets(method, params, result)) {
    const threadId = claimedThread(target, deps);
    if (threadId === null) continue;
    if (inactive && !claimsWhenInactive(method, deps.messaging.thread(threadId).kind)) continue;
    const note = claimThread(repo, { agentId: call.caller.id, sessionId, threadId, at });
    if (note) call.notes.push(note);
  }
}
