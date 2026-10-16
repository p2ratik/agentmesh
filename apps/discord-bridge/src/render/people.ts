import type { ConfigIndex } from '@agentmesh/config';
import { list } from './format';

/**
 * The Discord user to ping for a participant: a human's own account, or the
 * owner of an agent. Null when nobody is reachable on Discord.
 */
export function discordUserFor(index: ConfigIndex, participantId: string): string | null {
  const human = index.human(participantId) ?? index.human(index.agent(participantId)?.owner ?? '');
  return human?.discordUserId ?? null;
}

/** Display names for participant ids, as a short comma-separated list. */
export function names(index: ConfigIndex, ids: readonly string[], max = 10): string {
  return list(
    ids.map((id) => index.displayName(id)),
    max,
  );
}
