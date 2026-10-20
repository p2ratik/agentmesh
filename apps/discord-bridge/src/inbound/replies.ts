import { type Logger, redactSecrets } from '@agentmesh/common';
import type { ConfigIndex } from '@agentmesh/config';
import type { Message } from 'discord.js';
import { authorize } from '../auth';
import type { ThreadMirror } from '../discord/threads';
import type { EchoGuard } from '../echo';
import { errorText } from '../render/format';
import type { MeshRpc } from '../rpc';

export interface ReplyRelayDeps {
  rpc: MeshRpc;
  index: () => ConfigIndex;
  threads: ThreadMirror;
  echo: EchoGuard;
  logger: Logger;
}

/**
 * A configured human typing inside a mirrored Discord thread speaks in that
 * mesh thread: their message reaches the agents as `from_kind="human"`.
 * Bots, webhooks, DMs, unknown users and unmapped threads are ignored.
 */
export function createReplyRelay(deps: ReplyRelayDeps) {
  return async (message: Message): Promise<void> => {
    if (
      message.author.bot ||
      message.webhookId ||
      !message.inGuild() ||
      !message.channel.isThread()
    )
      return;
    const human = authorize(deps.index(), message.author.id);
    if (!human) return;
    const body = [message.content, ...message.attachments.map((a) => a.url)]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!body) return;
    try {
      const threadId = await deps.threads.meshThreadOf(message.channelId);
      if (!threadId) return;
      const relay = deps.rpc
        .call(
          'message.send',
          { kind: 'reply', threadId, body },
          { actAs: human.id, idempotencyKey: message.id },
        )
        .then((result) => result.messageId);
      await deps.echo.track(relay);
      await message.react('✅').catch(() => undefined);
    } catch (err) {
      deps.logger.warn({ err, discordMessage: message.id }, 'could not relay a human reply');
      await message
        .reply({ content: redactSecrets(errorText(err)), allowedMentions: { parse: [] } })
        .catch(() => undefined);
    }
  };
}
