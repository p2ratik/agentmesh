import type { Logger } from '@agentmesh/common';
import {
  ChannelType,
  type Client,
  type ForumChannel,
  type TextChannel,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
} from 'discord.js';
import type { ThreadTarget } from '../render/intents';
import type { MeshRpc } from '../rpc';

const SYSTEM = 'discord';

/**
 * Keeps one Discord thread (or forum post) per mesh thread. The mapping lives
 * in the hub (`refs.*`), so the bridge is stateless and survives restarts.
 */
export class ThreadMirror {
  readonly #rpc: MeshRpc;
  readonly #client: Client;
  readonly #logger: Logger;
  readonly #toDiscord = new Map<string, string>();
  readonly #toMesh = new Map<string, string>();

  constructor(rpc: MeshRpc, client: Client, logger: Logger) {
    this.#rpc = rpc;
    this.#client = client;
    this.#logger = logger;
  }

  /** The Discord thread for a mesh thread, created in `channel` on first use. */
  async resolve(target: ThreadTarget, channel: TextChannel | ForumChannel): Promise<ThreadChannel> {
    const known = await this.#lookup(target.threadId);
    if (known) {
      const existing = await this.#client.channels.fetch(known).catch(() => null);
      if (existing?.isThread()) return existing;
      this.#logger.warn({ thread: target.threadId }, 'mirrored discord thread is gone; recreating');
    }
    const thread = await create(target, channel);
    await this.#rpc.call('refs.set', {
      system: SYSTEM,
      entityType: 'thread',
      entityId: target.threadId,
      ref: thread.id,
    });
    this.#remember(target.threadId, thread.id);
    return thread;
  }

  /** The mesh thread a Discord thread mirrors, or null if it is not ours. */
  async meshThreadOf(discordThreadId: string): Promise<string | null> {
    const cached = this.#toMesh.get(discordThreadId);
    if (cached) return cached;
    const { entity } = await this.#rpc.call('refs.find', { system: SYSTEM, ref: discordThreadId });
    if (entity?.entityType !== 'thread') return null;
    this.#remember(entity.entityId, discordThreadId);
    return entity.entityId;
  }

  async #lookup(meshThreadId: string): Promise<string | null> {
    const cached = this.#toDiscord.get(meshThreadId);
    if (cached) return cached;
    const { ref } = await this.#rpc.call('refs.get', {
      system: SYSTEM,
      entityType: 'thread',
      entityId: meshThreadId,
    });
    if (ref) this.#remember(meshThreadId, ref);
    return ref;
  }

  #remember(meshThreadId: string, discordThreadId: string): void {
    this.#toDiscord.set(meshThreadId, discordThreadId);
    this.#toMesh.set(discordThreadId, meshThreadId);
  }
}

async function create(
  target: ThreadTarget,
  channel: TextChannel | ForumChannel,
): Promise<ThreadChannel> {
  if (channel.type === ChannelType.GuildForum) {
    return channel.threads.create({
      name: target.title,
      message: { content: target.starter, allowedMentions: { parse: [] } },
    });
  }
  const starter = await channel.send({ content: target.starter, allowedMentions: { parse: [] } });
  return starter.startThread({
    name: target.title,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  });
}
