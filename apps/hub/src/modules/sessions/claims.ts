import type { RpcMethodName, ThreadKind } from '@agentmesh/protocol';

/** What a successful RPC makes the calling session own. Keys are protocol keys (`thr-3`). */
export type ClaimTarget = { kind: 'thread' | 'task' | 'plan'; key: string };

/** Methods whose result carries the `threadId` of the thread they acted on. */
const CLAIMS_RESULT_THREAD: ReadonlySet<string> = new Set([
  'message.send',
  'escalate',
  'task.create',
  'task.act',
  'review.request',
  'review.submit',
  'plan.start',
  'plan.submit',
  'plan.cancel',
]);

/** Whether `claimTargets` can return anything for this method (the router runs these atomically). */
export function isClaiming(method: RpcMethodName): boolean {
  return CLAIMS_RESULT_THREAD.has(method) || method === 'plan.contribute' || method === 'inbox.get';
}

/** A private (inactive) session owns only its own conversations: it sends or escalates in one. */
export function claimsWhenInactive(method: RpcMethodName, kind: ThreadKind): boolean {
  return (
    (method === 'message.send' && kind === 'conversation') ||
    (method === 'escalate' && kind === 'escalation')
  );
}

/** The action (non-FYI) threads an `inbox.get` result returned; none while paused. */
function inboxThreads(result: unknown): ClaimTarget[] {
  if (typeof result !== 'object' || result === null) return [];
  const { threads, paused } = result as Record<string, unknown>;
  if (paused === true || !Array.isArray(threads)) return [];
  const out: ClaimTarget[] = [];
  for (const entry of threads) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { thread, fyi } = entry as Record<string, unknown>;
    const key = str(thread, 'id');
    if (key && fyi === false) out.push({ kind: 'thread', key });
  }
  return out;
}

function str(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as Record<string, unknown>)[field];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Pure; never throws on malformed params or result. Reads and unknown methods claim nothing. */
export function claimTargets(
  method: RpcMethodName,
  params: unknown,
  result: unknown,
): ClaimTarget[] {
  if (CLAIMS_RESULT_THREAD.has(method)) {
    const key = str(result, 'threadId');
    return key ? [{ kind: 'thread', key }] : [];
  }
  if (method === 'inbox.get') return inboxThreads(result);
  if (method === 'plan.contribute') {
    const key = str(params, 'planId');
    return key ? [{ kind: 'plan', key }] : [];
  }
  return [];
}
