import { discordApi } from '../discord-api';
import type { CheckResult } from './result';

/** Discord channel types: GUILD_TEXT, GUILD_CATEGORY, GUILD_FORUM. */
const TEXT = 0;
const CATEGORY = 4;
const FORUM = 15;

type Expected = Record<string, { name: string; type: 'text' | 'forum' }>;

/**
 * Judges a server's channels against the config: the category, and each channel by name
 * and type (the bridge reuses channels by name, wherever they are). Pure.
 */
export function classifyChannels(
  channels: Array<{ name: string; type: number; parent_id: string | null }>,
  category: string,
  expected: Expected,
): CheckResult {
  const has = (name: string, type: number) =>
    channels.some((c) => c.name === name && c.type === type);
  const missing = [
    ...(has(category, CATEGORY) ? [] : [`the category "${category}"`]),
    ...Object.values(expected)
      .filter((c) => !has(c.name, c.type === 'forum' ? FORUM : TEXT))
      .map((c) => `#${c.name}${c.type === 'forum' ? ' (a forum)' : ''}`),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      label: `Discord is missing ${missing.join(', ')}`,
      detail:
        'The bridge creates them when it starts. See `docker compose logs discord-bridge` in ' +
        'the deploy folder; the bot needs the permissions from its invite link.',
    };
  }
  const count = Object.keys(expected).length;
  return { ok: true, label: `Discord: category, ${count} channels and the planning forum exist` };
}

/** Lists the server's channels with the bot token and judges them; any failure is a ✗ line. */
export async function checkDiscord(
  token: string,
  guildId: string,
  discord: { provision: { category: string }; channels: Expected },
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  if (!token || !guildId) {
    return {
      ok: false,
      label: 'Discord is not set up',
      detail: 'Run setup discord.',
    };
  }
  try {
    const channels = await discordApi(token, fetchImpl).channels(guildId);
    return classifyChannels(channels, discord.provision.category, discord.channels);
  } catch (error) {
    // discordApi's messages never contain the token.
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, label: "Discord: cannot list the server's channels", detail };
  }
}
