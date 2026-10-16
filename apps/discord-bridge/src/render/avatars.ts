import type { ConfigIndex } from '@agentmesh/config';
import type { ParticipantRef } from '@agentmesh/protocol';

/** Discord hosts six coloured default avatars itself — no third-party image service involved. */
const DEFAULT_AVATAR_COUNT = 6;

/** One of Discord's built-in default avatars (`0`–`5`). */
export function discordDefaultAvatar(n: number): string {
  return `https://cdn.discordapp.com/embed/avatars/${n % DEFAULT_AVATAR_COUNT}.png`;
}

/**
 * The picture an agent's messages carry, so agents are easy to tell apart:
 * its configured `avatarUrl`, else a built-in Discord avatar picked by the
 * agent's position in config. Positions start at 1 because the webhook's own
 * default (used for humans and the hub) looks like avatar 0, so up to five
 * agents get colours nobody else uses. Humans and the hub get no override.
 */
export function avatarFor(ref: ParticipantRef, index: ConfigIndex): string | undefined {
  if (ref.kind !== 'agent') return undefined;
  const agent = index.agent(ref.id);
  if (agent?.avatarUrl) return agent.avatarUrl;
  const position = index.agents().findIndex((a) => a.id === ref.id);
  return position === -1 ? undefined : discordDefaultAvatar(position + 1);
}
