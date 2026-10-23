import { MeshError, VERSION } from '@agentmesh/common';
import { DiscordUserId } from '@agentmesh/protocol';
import { z } from 'zod';
import { DEFAULT_MARKETPLACE } from './defaults';

/**
 * The few Discord REST calls setup and doctor make with the bot token. The token goes
 * only into the Authorization header; no error message ever contains it.
 */

export const DISCORD_API = 'https://discord.com/api/v10';

/** Scopes and permissions from docs/discord.md. */
const BOT_SCOPES = 'bot+applications.commands';
const BOT_PERMISSIONS = '326954470480';

/** Every Discord id is a snowflake; these end up in .env and mesh.yaml. */
const Snowflake = DiscordUserId;
const User = z.object({ id: Snowflake, username: z.string() });
const Application = z.object({ id: Snowflake, name: z.string() });
const Guild = z.object({ id: Snowflake, name: z.string() });
const GuildDetail = Guild.extend({ owner_id: Snowflake });
const Channel = z.object({
  id: Snowflake,
  name: z.string(),
  type: z.number(),
  parent_id: Snowflake.nullable().default(null),
});

/** Base64url segments joined by dots. Anything else could echo the token in a header error. */
const TOKEN_SHAPE = /^[A-Za-z0-9._-]+$/;

export interface DiscordApi {
  me(): Promise<{ id: string; username: string }>;
  application(): Promise<{ id: string; name: string }>;
  guilds(): Promise<Array<{ id: string; name: string }>>;
  guild(id: string): Promise<{ id: string; name: string; owner_id: string }>;
  user(id: string): Promise<{ id: string; username: string }>;
  channels(
    guildId: string,
  ): Promise<Array<{ id: string; name: string; type: number; parent_id: string | null }>>;
}

export function discordApi(token: string, fetchImpl: typeof fetch): DiscordApi {
  if (!TOKEN_SHAPE.test(token)) {
    throw new MeshError(
      'unauthenticated',
      'The bot token in deploy/.env has characters a Discord token never has (a quote or a ' +
        'space?). Copy it again from the developer portal, paste it into the file and run again.',
    );
  }
  async function get<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
    const response = await fetchImpl(`${DISCORD_API}${path}`, {
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': `DiscordBot (https://github.com/${DEFAULT_MARKETPLACE}, ${VERSION})`,
      },
    });
    if (response.status === 401) {
      throw new MeshError(
        'unauthenticated',
        'Discord rejected the bot token in deploy/.env (401). Reset it in the developer ' +
          'portal, paste the new one into the file and run again.',
      );
    }
    // The token is fine: resetting it would break the running bridge for nothing.
    if (response.status === 403) {
      throw new MeshError(
        'forbidden',
        `Discord API ${path} answered 403: the bot has no access there. Is it still in the ` +
          'server, with the permissions from the invite link?',
      );
    }
    if (!response.ok) {
      throw new MeshError('unavailable', `Discord API ${path} answered ${response.status}`);
    }
    const parsed = schema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
    throw new MeshError(
      'unavailable',
      `Discord API ${path} answered an unexpected body:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    me: () => get('/users/@me', User),
    application: () => get('/applications/@me', Application),
    guilds: () => get('/users/@me/guilds', z.array(Guild)),
    guild: (id) => get(`/guilds/${id}`, GuildDetail),
    user: (id) => get(`/users/${id}`, User),
    channels: (guildId) => get(`/guilds/${guildId}/channels`, z.array(Channel)),
  };
}

/** The link that adds the bot to a server with the scopes and permissions the bridge needs. */
export function botInviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=${BOT_SCOPES}&permissions=${BOT_PERMISSIONS}`;
}
