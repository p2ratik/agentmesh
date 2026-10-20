import { createLogger, MeshError } from '@agentmesh/common';
import { ConfigIndex, configFromObject } from '@agentmesh/config';
import type { Interaction } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ChannelDirectory } from '../discord/directory';
import type { MeshRpc } from '../rpc';
import { createInteractionHandler } from './router';

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

/** `/task create title:<title>` from Alice; returns everything the bridge replied. */
async function taskCreate(title: string, hub: MeshRpc['call']): Promise<string[]> {
  const replies: string[] = [];
  const interaction = {
    id: 'int-1',
    user: { id: '100000000000000001' },
    commandName: 'task',
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isButton: () => false,
    options: {
      getSubcommand: () => 'create',
      getString: (name: string) => (name === 'title' ? title : null),
      getInteger: () => null,
    },
    deferReply: async () => undefined,
    editReply: async ({ content }: { content: string }) => void replies.push(content),
  } as unknown as Interaction;
  const handle = createInteractionHandler({
    rpc: { call: hub } as MeshRpc,
    index: () => index,
    enrolled: () => ({ members: [], invites: [] }),
    refreshInvites: async () => undefined,
    directory: {} as ChannelDirectory,
    logger: createLogger('router-test', { level: 'silent', destination: 'stderr' }),
  });
  await handle(interaction);
  return replies;
}

describe('slash command replies', () => {
  it('mask secrets the reply echoes (a public /task create shows the title)', async () => {
    const replies = await taskCreate(`Rotate ${TOKEN}`, (async (
      _method: string,
      params: unknown,
    ) => ({
      id: 'task-9',
      title: (params as { title: string }).title,
      assignee: null,
      state: 'backlog',
    })) as MeshRpc['call']);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('task-9');
    expect(replies[0]).not.toContain(TOKEN);
    expect(replies[0]).toContain('[REDACTED]');
  });

  it('mask secrets in an error the hub sends back', async () => {
    const replies = await taskCreate('x', (async () => {
      throw new MeshError('invalid_request', `title may not contain ${TOKEN}`);
    }) as MeshRpc['call']);
    expect(replies[0]).not.toContain(TOKEN);
  });
});
