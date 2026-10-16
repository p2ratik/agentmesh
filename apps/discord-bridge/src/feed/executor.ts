import type { Logger } from '@agentmesh/common';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  DiscordAPIError,
  type ForumChannel,
  type MessageMentionOptions,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { chunkMessage } from '../discord/chunk';
import type { ChannelDirectory } from '../discord/directory';
import type { ThreadMirror } from '../discord/threads';
import type { WebhookCache } from '../discord/webhooks';
import { oneLine, threadTitle } from '../render/format';
import type { IntentButton, PostIntent } from '../render/intents';

const STYLES: Record<IntentButton['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Discord errors that will never succeed on retry (missing channel, permissions, bad payload). */
const PERMANENT = new Set([10003, 10008, 10015, 50001, 50013, 50035]);

export function isPermanentDiscordError(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError && typeof error.code === 'number' && PERMANENT.has(error.code)
  );
}

export interface ExecutorDeps {
  client: Client;
  directory: ChannelDirectory;
  webhooks: WebhookCache;
  threads: ThreadMirror;
  logger: Logger;
}

/** Performs post intents with discord.js. All decisions were made by the renderers. */
export class Executor {
  readonly #deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.#deps = deps;
  }

  async perform(intent: PostIntent): Promise<void> {
    const channelId = this.#deps.directory.channelFor(intent.purpose);
    if (!channelId) {
      this.#deps.logger.warn({ purpose: intent.purpose }, 'no discord channel for purpose');
      return;
    }
    const channel = (await this.#deps.client.channels.fetch(channelId)) as
      | TextChannel
      | ForumChannel
      | null;
    if (!channel) return;
    const thread = await this.#threadFor(intent, channel);
    const chunks = chunkMessage(intent.content);
    const allowedMentions: MessageMentionOptions = intent.mentionUserIds?.length
      ? { parse: [], users: intent.mentionUserIds }
      : { parse: [] };
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      const buttons = last && intent.buttons?.length ? [row(intent.buttons)] : [];
      if (intent.username && buttons.length === 0) {
        await this.#sendAsParticipant(intent, channel, thread, chunk, allowedMentions);
      } else {
        await sendAsBot(thread ?? channel, chunk, allowedMentions, buttons);
      }
    }
  }

  /** The mirrored thread, or — for a forum without one — a new post (forums have no plain channel). */
  async #threadFor(
    intent: PostIntent,
    channel: TextChannel | ForumChannel,
  ): Promise<ThreadChannel | null> {
    if (intent.thread) return this.#deps.threads.resolve(intent.thread, channel);
    if (channel.type !== ChannelType.GuildForum) return null;
    return channel.threads.create({
      name: threadTitle('notice', oneLine(intent.content, 90)),
      message: { content: oneLine(intent.content, 300), allowedMentions: { parse: [] } },
    });
  }

  async #sendAsParticipant(
    intent: PostIntent,
    channel: TextChannel | ForumChannel,
    thread: ThreadChannel | null,
    content: string,
    allowedMentions: MessageMentionOptions,
  ): Promise<void> {
    const webhook = await this.#deps.webhooks.for(channel);
    await webhook.send({
      content,
      username: intent.username,
      ...(intent.avatarURL ? { avatarURL: intent.avatarURL } : {}),
      ...(thread ? { threadId: thread.id } : {}),
      allowedMentions,
    });
  }
}

function sendAsBot(
  target: TextChannel | ForumChannel | ThreadChannel,
  content: string,
  allowedMentions: MessageMentionOptions,
  components: ActionRowBuilder<ButtonBuilder>[],
) {
  if (target.type === ChannelType.GuildForum) throw new Error('cannot post directly into a forum');
  return target.send({ content, allowedMentions, components });
}

function row(buttons: readonly IntentButton[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...buttons.map((b) =>
      new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(STYLES[b.style]),
    ),
  );
}
