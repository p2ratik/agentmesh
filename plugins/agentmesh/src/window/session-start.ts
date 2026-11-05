// Built-ins only: the hook bundle imports this (common/window imports nothing but node:*).
import { START_COMMAND, type WindowPolicy } from '@agentmesh/common/window';
import { windowRules } from './rules';

export const HINT_START = `No AgentMesh mesh window is running for this account, so teammates' requests will wait. Start it with ${START_COMMAND} in your team's folder. (AGENTMESH_MESH_WINDOW_HINT=off in settings.json env hides this line.)`;
export const HINT_SETUP =
  "No AgentMesh mesh window is running for this account, so teammates' requests will wait. Run /agentmesh:window to set one up. (AGENTMESH_MESH_WINDOW_HINT=off in settings.json env hides this line.)";

export interface SessionStartInput {
  source: string | undefined;
  marked: boolean;
  policy: WindowPolicy | null;
  enrolled: boolean;
  hintOff: boolean;
  listening: boolean;
  setUp: boolean;
}

/** The mesh window gets its rules every start; other sessions hear about a missing window once, at startup. */
export function sessionStartOutput(i: SessionStartInput): {
  additionalContext: string | null;
  systemMessage: string | null;
} {
  if (i.marked) return { additionalContext: windowRules(i.policy), systemMessage: null };
  const hint = i.source === 'startup' && i.enrolled && !i.hintOff && !i.listening;
  return {
    additionalContext: null,
    systemMessage: hint ? (i.setUp ? HINT_START : HINT_SETUP) : null,
  };
}
