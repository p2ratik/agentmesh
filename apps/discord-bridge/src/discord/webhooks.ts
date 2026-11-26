import type { ForumChannel, TextChannel, Webhook } from 'discord.js';

const WEBHOOK_NAME = 'Cosmicwave';
/** The name before the rename; webhooks made then are reused, not duplicated. */
export const LEGACY_WEBHOOK_NAME = 'AgentMesh';

/** Our webhook (it needs a token to post): the current name wins over the old one. */
export function pickWebhook<T extends { name: string; token: string | null }>(
  hooks: Iterable<T>,
): T | undefined {
  const usable = [...hooks].filter((h) => Boolean(h.token));
  return (
    usable.find((h) => h.name === WEBHOOK_NAME) ??
    usable.find((h) => h.name === LEGACY_WEBHOOK_NAME)
  );
}

/**
 * One webhook per parent channel, reused across restarts. Webhooks let each
 * participant's messages appear under their own name and avatar, and can
 * post into the channel's threads and forum posts.
 */
export class WebhookCache {
  readonly #byChannel = new Map<string, Promise<Webhook>>();

  for(channel: TextChannel | ForumChannel): Promise<Webhook> {
    let hook = this.#byChannel.get(channel.id);
    if (!hook) {
      hook = findOrCreate(channel);
      this.#byChannel.set(channel.id, hook);
      hook.catch(() => this.#byChannel.delete(channel.id));
    }
    return hook;
  }

  /** Forget a webhook Discord no longer knows (it was deleted). */
  evict(channelId: string): void {
    this.#byChannel.delete(channelId);
  }
}

async function findOrCreate(channel: TextChannel | ForumChannel): Promise<Webhook> {
  const hooks = await channel.fetchWebhooks();
  const ours = pickWebhook(hooks.values());
  return ours ?? channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Cosmicwave mirroring' });
}
