// Built-ins only: the hook bundle imports this (common/window imports nothing but node:*).
import { START_COMMAND, type WindowPolicy } from '@agentmesh/common/window';
import { windowRules } from './rules';

export const HINT_START = `No AgentMesh mesh window is running for this account, so teammates' requests will wait. Start it with ${START_COMMAND} in your team's folder. (AGENTMESH_MESH_WINDOW_HINT=off in settings.json env hides this line.)`;
export const HINT_SETUP =
  "No AgentMesh mesh window is running for this account, so teammates' requests will wait. Run /agentmesh:window to set one up. (AGENTMESH_MESH_WINDOW_HINT=off in settings.json env hides this line.)";

/** A policy with no `mode` was written before auto mode: that window's launcher starts it manual. */
export const HINT_MANUAL =
  'This mesh window was set up before auto mode, so it starts in manual mode. Run /agentmesh:window again to start it in auto mode (or keep manual: agentmesh window init --mode manual).';

export interface SessionStartInput {
  source: string | undefined;
  marked: boolean;
  policy: WindowPolicy | null;
  enrolled: boolean;
  hintOff: boolean;
  listening: boolean;
  setUp: boolean;
}

/** The mesh window gets its rules every start (and, set up before auto mode, says so); other
 * sessions hear about a missing window once, at startup. */
export function sessionStartOutput(i: SessionStartInput): {
  additionalContext: string | null;
  systemMessage: string | null;
} {
  if (i.marked) {
    const old = i.policy !== null && i.policy.mode === undefined;
    return { additionalContext: windowRules(i.policy), systemMessage: old ? HINT_MANUAL : null };
  }
  const hint = i.source === 'startup' && i.enrolled && !i.hintOff && !i.listening;
  return {
    additionalContext: null,
    systemMessage: hint ? (i.setUp ? HINT_START : HINT_SETUP) : null,
  };
}
