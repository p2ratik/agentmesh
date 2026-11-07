import type { Logger } from '@agentmesh/common';
import type { ReasonCode, SessionSummary } from '@agentmesh/protocol';
import type { HubClient } from '../hub';
import type { ChannelEvent } from '../inbox/render';
import { recordActivation, recordActivationError } from '../telemetry/plugin-events';
import type { Recorder } from '../telemetry/recorder';
import type { MeshWindowContext } from '../window/context';
import { freshGuardStamp } from '../window/guard-stamp';

/**
 * What this window was active as. The hub sends the activation code (spec §3);
 * the plugin only remembers enough to re-check after the hub renews its session.
 */
export interface ActivationState {
  /** This session's description while it is active; null before activation and after deactivate. */
  lastDescription: string | null;
  /** The line an active session had when the hub replaced it; the next check suggests it again. */
  renewedFrom: string | null;
  /** Active in pull mode (ADR 0008): nothing is pushed; the prompt hook announces unread work. */
  pull: boolean;
  /**
   * The mesh window's guard version, read from its stamp on the last successful activate and kept
   * while the process lives (the guard and this server update together, and an update restarts
   * the server); null before then, from a guard before 0.6.0, after deactivate, or once activate
   * finds the guard did not run. Relays gate on it.
   */
  guardVersion: string | null;
  /** Bumped by each deactivate, before its hub call: an activation still out then must not stand. */
  epoch: number;
}

export const newActivationState = (): ActivationState => ({
  lastDescription: null,
  renewedFrom: null,
  pull: false,
  guardVersion: null,
  epoch: 0,
});

/**
 * The human's own activate is a first activation: a renewal in progress (the session is inactive
 * on the hub) ends, so its check goes to Claude, with the human's line, and is never answered with
 * the old one (`answerCheck`).
 */
export function endRenewal(activation: ActivationState): void {
  if (activation.renewedFrom === null) return;
  activation.renewedFrom = null;
  activation.lastDescription = null;
}

/**
 * The channel event that carries a code. `previous` is set when the hub gave
 * this process a new session after a long absence, and is suggested again.
 */
export function checkEvent(code: string, previous?: string): ChannelEvent {
  const intro = previous
    ? 'This session reconnected to the mesh after a long absence. Your human activated it earlier; finishing this check continues that activation. '
    : '';
  const description = previous ?? '<one line: what this session is working on>';
  const outro = previous ? ' Write a new line instead if the focus changed.' : '';
  return {
    content: `${intro}AgentMesh activation check. Code: ${code}. To finish, call activate(code: "${code}", description: "${description}").${outro}`,
    meta: { kind: 'system', from: 'agentmesh' },
  };
}

/**
 * Activates this session, for pushes with the code from its check or in pull mode, and records it:
 * the line, the mode, and the guard version from the mesh window's fresh stamp when one is given.
 * The activate tool's push activation and both renewals (`answerCheck`, `reactivatePull`) go
 * through here. A deactivate while the call was out wins: nothing is recorded, the hub (which may
 * have run the deactivate first) is turned off again, and the result is null. Otherwise it is the
 * threads a takeover moved here from the agent's away windows (`tookOverLines` says so to Claude).
 */
export async function activateSession(
  hub: Pick<HubClient, 'call'>,
  activation: ActivationState,
  params: { code: string; description: string } | { mode: 'pull'; description: string },
  stamp: { version: string | null } | null,
): Promise<string[] | null> {
  const epoch = activation.epoch;
  const view = await hub.call('session.activate', params);
  if (activation.epoch !== epoch) {
    await hub.call('session.deactivate', {});
    return null;
  }
  activation.lastDescription = view.description ?? params.description;
  activation.renewedFrom = null;
  activation.pull = 'mode' in params;
  // From the stamp this call checked: relays gate on it for the life of the process.
  if (stamp) activation.guardVersion = stamp.version;
  return view.tookOver ?? [];
}

/** What Claude is told about threads a takeover moved to this window, each on its own line. */
export function tookOverLines(threads: readonly string[]): string {
  return threads
    .map(
      (t) =>
        `Took over ${t} from your earlier mesh window, which had gone away; read it with thread ${t} to pick up where it left off.`,
    )
    .join('\n');
}

/**
 * Why a renewal can't answer its check itself, or null when it can: the activate tool's window
 * checks. The marker must verify, and the mesh window's guard must be known to run: by the version
 * its last activate in this process recorded (the guard stamps only an activate call, so after a
 * long sleep the stamp is stale; a failed check clears the version), or by a fresh `stamp`. A
 * window the takeover replaced leaves it to its human while another live window is active.
 */
function renewalRefused(
  window: MeshWindowContext,
  activation: ActivationState,
  stamp: { version: string | null } | null,
  others: readonly SessionSummary[],
): [ReasonCode, string] | null {
  if (window.state === 'marked')
    return ['marker.unverified', 'the mesh window marker does not verify'];
  if (window.state !== 'verified') return null;
  if (activation.guardVersion === null && !stamp) {
    return ['activation.no_proof', 'no proof that the worktree guard runs'];
  }
  if (others.some((s) => s.meshWindow && s.liveness === 'live')) {
    return ['activation.another_window_live', 'another mesh window of this agent is live'];
  }
  return null;
}

export interface CheckDeps {
  hub: Pick<HubClient, 'call' | 'sessionId'>;
  activation: ActivationState;
  window: MeshWindowContext;
  logger: Logger;
  /** Writes one channel event to Claude. */
  push(event: ChannelEvent): Promise<void>;
  /** Refreshes the hooks' local file (the heartbeat of an active session). */
  refresh(): Promise<void>;
  /** The agent's active sessions, as the latest hello listed them (`hello.self.sessions`). */
  agentSessions(): readonly SessionSummary[];
  recorder: Recorder;
}

/**
 * The hub's check code reached this session. On a first activation it goes to Claude, who finishes
 * what the human started. After a renewal in this process (`renewedFrom`: its last activation was
 * a push one that succeeded), the push leg the code proves was already proven, since Claude Code
 * fixes the channel flag per process: the plugin answers the code itself. If that fails, Claude
 * gets the check after all, unless the human deactivated meanwhile: their off stands.
 */
export async function answerCheck(code: string, deps: CheckDeps): Promise<void> {
  const { hub, activation, logger, recorder } = deps;
  const previous = activation.renewedFrom;
  if (previous === null) return deps.push(checkEvent(code));
  const session = hub.sessionId;
  const { window } = deps;
  // As in the activate tool: a fresh stamp records its version.
  const stamp = window.state === 'verified' ? freshGuardStamp(window.dataDir, Date.now()) : null;
  const others = deps.agentSessions().filter((s) => s.id !== session);
  const refused = renewalRefused(window, activation, stamp, others);
  if (refused) {
    logger.warn({ session, reason: refused[1] }, 'could not re-activate the new hub session');
    recordActivation(recorder, session, 'renewal_fallback', false, refused[0]);
    return deps.push(checkEvent(code, previous));
  }
  const epoch = activation.epoch;
  let took: string[] | null;
  try {
    took = await activateSession(hub, activation, { code, description: previous }, stamp);
  } catch (err) {
    logger.warn({ session, err }, 'could not re-activate the new hub session');
    recordActivation(recorder, session, 'renewal_fallback', false, 'activation.hub_error');
    if (activation.epoch === epoch) await deps.push(checkEvent(code, previous));
    return;
  }
  if (took === null) {
    logger.warn({ session }, 'deactivated while re-activating the new hub session; it stays off');
    return;
  }
  logger.info({ session }, 'new hub session; re-activated it in the same process');
  recordActivation(recorder, session, 'renewed', false);
  void deps.refresh();
  const extra = took.length > 0 ? `\n${tookOverLines(took)}` : '';
  await deps.push({
    content: `AgentMesh: this session reconnected after a long absence and is active again as "${previous}". Call inbox to catch up.${extra}`,
    meta: { kind: 'system', from: 'agentmesh' },
  });
}

/**
 * A pull session the hub renewed: no check to answer, so it re-activates in pull mode at once. A
 * deactivate meanwhile wins, as in `activateSession`.
 */
export async function reactivatePull(
  deps: Pick<CheckDeps, 'hub' | 'activation' | 'logger' | 'refresh' | 'recorder'>,
): Promise<void> {
  const { hub, activation, logger, recorder } = deps;
  const description = activation.lastDescription;
  if (description === null) return;
  const session = hub.sessionId;
  logger.info({ session }, 'new hub session; re-activating it in pull mode');
  try {
    if ((await activateSession(hub, activation, { mode: 'pull', description }, null)) === null) {
      logger.warn({ session }, 'deactivated while re-activating the pull session; it stays off');
      return;
    }
  } catch (err) {
    logger.warn({ err }, 'could not re-activate the pull session');
    recordActivationError(recorder, session, true, err);
    return;
  }
  recordActivation(recorder, session, 'renewed', true);
  await deps.refresh();
}
