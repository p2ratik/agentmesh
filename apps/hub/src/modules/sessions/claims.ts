import type { RpcMethodName } from '@agentmesh/protocol';

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
  return CLAIMS_RESULT_THREAD.has(method) || method === 'plan.contribute';
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
  if (method === 'plan.contribute') {
    const key = str(params, 'planId');
    return key ? [{ kind: 'plan', key }] : [];
  }
  return [];
}
