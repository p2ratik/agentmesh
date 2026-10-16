import type { Logger } from '@agentmesh/common';
import type { DiscordConfig } from '@agentmesh/config';
import { type CategoryChannel, ChannelType, type Guild, type GuildBasedChannel } from 'discord.js';
import { ChannelDirectory } from './directory';

type Wanted = DiscordConfig['channels'][string];

const typeOf = (wanted: Wanted) =>
  wanted.type === 'forum' ? ChannelType.GuildForum : ChannelType.GuildText;

/**
 * Finds (and with `provision.enabled`, creates) one channel per configured
 * purpose inside the mesh category. Existing channels are reused by name, so
 * restarts and renamed categories are harmless.
 */
export async function provisionChannels(
  guild: Guild,
  discord: DiscordConfig,
  logger: Logger,
): Promise<ChannelDirectory> {
  await guild.channels.fetch();
  const create = discord.provision.enabled;
  const category = create ? await ensureCategory(guild, discord.provision.category) : null;
  const byPurpose = new Map<string, string>();
  for (const [purpose, wanted] of Object.entries(discord.channels)) {
    const existing = guild.channels.cache.find(
      (c: GuildBasedChannel) => c.name === wanted.name && c.type === typeOf(wanted),
    );
    if (existing) {
      byPurpose.set(purpose, existing.id);
      continue;
    }
    if (!create) {
      throw new Error(
        `Discord channel #${wanted.name} (${purpose}) not found and provisioning is disabled`,
      );
    }
    const channel = await guild.channels.create({
      name: wanted.name,
      type: typeOf(wanted),
      parent: category,
      ...(wanted.topic ? { topic: wanted.topic } : {}),
      reason: `AgentMesh ${purpose} channel`,
    });
    logger.info({ purpose, channel: channel.name }, 'created discord channel');
    byPurpose.set(purpose, channel.id);
  }
  return new ChannelDirectory(byPurpose);
}

async function ensureCategory(guild: Guild, name: string): Promise<CategoryChannel> {
  const found = guild.channels.cache.find(
    (c: GuildBasedChannel): c is CategoryChannel =>
      c.type === ChannelType.GuildCategory && c.name === name,
  );
  return (
    found ?? guild.channels.create({ name, type: ChannelType.GuildCategory, reason: 'AgentMesh' })
  );
}
