import type { ConfigIndex, HumanConfig } from '@agentmesh/config';

export const NOT_A_MEMBER =
  "You're not a member of this mesh. Ask a mesh admin to add your Discord user id to mesh.yaml.";

/**
 * Maps a Discord user to the configured human they are. Only humans listed in
 * config (by `discordUserId`) may command the mesh; everyone else gets null.
 */
export function authorize(index: ConfigIndex, discordUserId: string): HumanConfig | null {
  return index.humanByDiscordId(discordUserId) ?? null;
}
