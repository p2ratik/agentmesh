import { createLogger, MeshError } from '@agentmesh/common';
import { ConfigIndex, configFromObject } from '@agentmesh/config';
import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ThreadMirror } from '../discord/threads';
import { EchoGuard } from '../echo';
import type { MeshRpc } from '../rpc';
import { createReplyRelay } from './replies';

/** Assembled at runtime so repository secret scanners never flag this file. */
const TOKEN = ['ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('');

const index = new ConfigIndex(
  configFromObject({
    version: 1,
    mesh: { name: 'acme' },
    humans: [{ id: 'alice', displayName: 'Alice', discordUserId: '100000000000000001' }],
    agents: [{ id: 'alice-agent', owner: 'alice' }],
  }).config,
);

describe('human replies relayed from Discord', () => {
  it('mask secrets in the error the bridge posts back when the hub refuses one', async () => {
    const posted: string[] = [];
    const message = {
      id: 'discord-msg-1',
      author: { id: '100000000000000001', bot: false },
      webhookId: null,
      inGuild: () => true,
      channel: { isThread: () => true },
      channelId: 'discord-thread-1',
      content: 'Looks good to me',
      attachments: [],
      react: async () => undefined,
      reply: async ({ content }: { content: string }) => void posted.push(content),
    } as unknown as Message;
    const relay = createReplyRelay({
      rpc: {
        call: async () => {
          throw new MeshError('invalid_request', `body may not contain ${TOKEN}`);
        },
      } as unknown as MeshRpc,
      index: () => index,
      threads: { meshThreadOf: async () => 'thr-1' } as unknown as ThreadMirror,
      echo: new EchoGuard(),
      logger: createLogger('replies-test', { level: 'silent', destination: 'stderr' }),
    });
    await relay(message);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain(TOKEN);
    expect(posted[0]).toContain('[REDACTED]');
  });
});
