import type { ForumChannel, TextChannel, Webhook } from 'discord.js';

const WEBHOOK_NAME = 'AgentMesh';

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
  const ours = hooks.find((h) => h.name === WEBHOOK_NAME && Boolean(h.token));
  return ours ?? channel.createWebhook({ name: WEBHOOK_NAME, reason: 'AgentMesh mirroring' });
}
