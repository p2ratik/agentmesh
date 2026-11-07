import { isMeshError } from '@agentmesh/common';
import type { ReasonCode } from '@agentmesh/protocol';
import { sweepExpired } from '../relay/forward-record';
import type { Recorder } from './recorder';

type Phase =
  | 'check_sent'
  | 'activated'
  | 'refused'
  | 'failed'
  | 'renewed'
  | 'renewal_fallback'
  | 'deactivated';

/** Records an activation step: a phase, the mode, and a reason code when it says no. */
export function recordActivation(
  recorder: Recorder,
  session: string | null,
  phase: Phase,
  pull: boolean,
  reason?: ReasonCode,
): void {
  const mode = pull ? 'pull' : 'push';
  recorder.record({ kind: 'activation', source: 'plugin', session, phase, mode, reason });
}

/** An activate that threw: the hub refusing the code is `refused`, anything else `failed`. */
export function recordActivationError(
  recorder: Recorder,
  session: string | null,
  pull: boolean,
  err: unknown,
): void {
  const wrong = isMeshError(err) && err.code === 'invalid_request';
  const reason = wrong ? 'activation.wrong_code' : 'activation.hub_error';
  recordActivation(recorder, session, wrong ? 'refused' : 'failed', pull, reason);
}

/**
 * The activate tool's recording helpers for one call: `record` a phase, `refuse` (records, then
 * hands back the error to throw), and `step` (a hub call whose failure is recorded and rethrown).
 */
export function activationRecorder(
  recorder: Recorder,
  hub: { sessionId: string | null },
  pull: boolean,
) {
  const record = (phase: 'check_sent' | 'activated' | 'refused', reason?: ReasonCode) =>
    recordActivation(recorder, hub.sessionId, phase, pull, reason);
  const refuse = (reason: ReasonCode, err: Error): Error => {
    record('refused', reason);
    return err;
  };
  const step = async <T>(call: Promise<T>): Promise<T> => {
    try {
      return await call;
    } catch (err) {
      recordActivationError(recorder, hub.sessionId, pull, err);
      throw err;
    }
  };
  return { record, refuse, step };
}

/** Records one stage of a delivery; `since` is when the plugin received it (ms epoch). */
export function recordDelivery(
  recorder: Recorder,
  session: string | null,
  m: { id: string; threadId: string },
  stage: 'received' | 'pushed' | 'push_failed' | 'deduped' | 'held',
  since: number,
): void {
  const sinceReceivedMs = Math.max(0, Date.now() - since);
  const { id: message, threadId: thread } = m;
  recorder.record({
    kind: 'delivery',
    source: 'plugin',
    session,
    message,
    thread,
    stage,
    sinceReceivedMs,
  });
}

/** Records a relay pointer the window pushed. */
export function recordRelayPushed(
  recorder: Recorder,
  session: string | null,
  relay: { messageId: string; threadId: string },
): void {
  const { messageId: message, threadId: thread } = relay;
  recorder.record({ kind: 'relay', source: 'plugin', session, message, thread, stage: 'pushed' });
}

/** Reports each forward record that expired unclaimed, once (the sweep removes it). */
export function recordExpired(recorder: Recorder, session: string | null, dir: string): void {
  for (const { messageId: message, threadId: thread } of sweepExpired(dir, Date.now())) {
    recorder.record({
      kind: 'relay',
      source: 'plugin',
      session,
      message,
      thread,
      stage: 'expired',
    });
  }
}

const IDS = { thread: /^thr-\d{1,12}$/, task: /^task-\d{1,12}$/, plan: /^plan-\d{1,12}$/ } as const;

/**
 * Records one tool call: its name, outcome (`ok` or an error code) and duration, plus the ids from
 * the `thread_id`, `task_id` and `plan_id` arguments. No other argument is ever read.
 */
export function recordTool(
  deps: { recorder: Recorder; hub: { sessionId: string | null } },
  tool: string,
  args: unknown,
  outcome: string,
  started: number,
): void {
  const a = (args ?? {}) as Record<string, unknown>;
  const ids: Record<string, string> = {};
  for (const key of ['thread', 'task', 'plan'] as const) {
    const v = a[`${key}_id`];
    if (typeof v === 'string' && IDS[key].test(v)) ids[key] = v;
  }
  deps.recorder.record({
    kind: 'tool',
    source: 'plugin',
    session: deps.hub.sessionId,
    tool,
    outcome,
    ms: Date.now() - started,
    ...ids,
  });
}
