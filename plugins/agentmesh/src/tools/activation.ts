import type { ChannelEvent } from '../inbox/render';

/**
 * What this window was active as. The hub sends the activation code (spec §3);
 * the plugin only remembers enough to re-check after the hub renews its session.
 */
export interface ActivationState {
  /** This session's description while it is active; null before activation and after deactivate. */
  lastDescription: string | null;
  /** The line an active session had when the hub replaced it; the next check suggests it again. */
  renewedFrom: string | null;
}

export const newActivationState = (): ActivationState => ({
  lastDescription: null,
  renewedFrom: null,
});

/**
 * The channel event that carries a code. `previous` is set when the hub gave
 * this process a new session after a long absence, and is suggested again.
 */
export function checkEvent(code: string, previous?: string): ChannelEvent {
  const intro = previous
    ? 'This session reconnected to the mesh after a long absence and is no longer active. '
    : '';
  const description = previous ?? '<one line: what this session is working on>';
  const outro = previous ? ' Write a new line instead if the focus changed.' : '';
  return {
    content: `${intro}AgentMesh activation check. Code: ${code}. To finish, call activate(code: "${code}", description: "${description}").${outro}`,
    meta: { kind: 'system', from: 'agentmesh' },
  };
}
