import { createLogger, MeshError } from '@agentmesh/common';
import { ConfigIndex, configFromObject } from '@agentmesh/config';
import type { Interaction } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { planButtonId } from '../custom-ids';
import type { ChannelDirectory } from '../discord/directory';
import { type HumanCall, type MeshRpc, maskResults } from '../rpc';
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

/** `/task <sub>` with these string options, from Alice; returns everything the bridge replied. */
async function slashTask(
  sub: string,
  options: Record<string, string>,
  hub: MeshRpc['call'],
): Promise<string[]> {
  const replies: string[] = [];
  const interaction = {
    id: 'int-1',
    user: { id: '100000000000000001' },
    commandName: 'task',
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isButton: () => false,
    options: {
      getSubcommand: () => sub,
      getString: (name: string) => options[name] ?? null,
      getInteger: () => null,
    },
    deferReply: async () => undefined,
    editReply: async ({ content }: { content: string }) => void replies.push(content),
  } as unknown as Interaction;
  await handlerFor(hub)(interaction);
  return replies;
}

const handlerFor = (hub: MeshRpc['call']) =>
  createInteractionHandler({
    rpc: { call: hub } as MeshRpc,
    index: () => index,
    enrolled: () => ({ members: [], invites: [] }),
    refreshInvites: async () => undefined,
    directory: {} as ChannelDirectory,
    logger: createLogger('router-test', { level: 'silent', destination: 'stderr' }),
  });

describe('slash command replies', () => {
  it('mask secrets the reply echoes (a public /task create shows the title)', async () => {
    const replies = await slashTask('create', { title: `Rotate ${TOKEN}` }, (async (
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
    const replies = await slashTask('create', { title: 'x' }, (async () => {
      throw new MeshError('invalid_request', `title may not contain ${TOKEN}`);
    }) as MeshRpc['call']);
    expect(replies[0]).not.toContain(TOKEN);
  });

  it('mask secrets in an error a plan button gets back', async () => {
    const replies: string[] = [];
    const interaction = {
      id: 'int-2',
      user: { id: '100000000000000001' },
      customId: planButtonId('approve', 'plan-1'),
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      deferUpdate: async () => undefined,
      followUp: async ({ content }: { content: string }) => void replies.push(content),
    } as unknown as Interaction;
    await handlerFor((async () => {
      throw new MeshError('invalid_request', `plan-1 cannot be approved: ${TOKEN}`);
    }) as MeshRpc['call'])(interaction);
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain(TOKEN);
  });

  it('keep the brackets of a link whose query string was masked (/task show)', async () => {
    const detail = {
      id: 'task-9',
      title: 'Add retries',
      state: 'in_review',
      priority: 'normal',
      workflow: 'feature',
      assignee: 'alice-agent',
      reviewers: [],
      createdBy: 'alice',
      prUrl: 'https://x/pr/1?token=abc123def456',
      dependsOn: [],
      description: '',
    };
    const replies = await slashTask(
      'show',
      { task: 'task-9' },
      (async () => detail) as unknown as MeshRpc['call'],
    );
    // Masking the rendered reply instead would swallow the closing bracket.
    expect(replies[0]).toContain('PR: <https://x/pr/1?token=[REDACTED]>');
  });
});

describe('maskResults', () => {
  const hub = (result: unknown): HumanCall => (async () => result) as HumanCall;

  it('masks results before a reply is rendered, so links keep their brackets', async () => {
    const call = maskResults(
      hub({ id: 'task-9', title: `Rotate ${TOKEN}`, prUrl: 'https://x/pr/1?token=abc123def456' }),
    );
    const task = (await call('task.get', { taskId: 'task-9' })) as unknown as {
      title: string;
      prUrl: string;
    };
    expect(task.title).toBe('Rotate [REDACTED]');
    expect(task.prUrl).toBe('https://x/pr/1?token=[REDACTED]');
  });

  it("passes the invite's code through untouched: it goes into a DM", async () => {
    // A code that happens to look like a token must still arrive exactly.
    const code = ['xox', 'b-', '1234567890abcdefghij'].join('');
    const call = maskResults(hub({ inviteId: 'inv-1', code }));
    const params = { humanId: 'dana', displayName: 'Dana', discordUserId: '100000000000000009' };
    expect(await call('enrollment.invite', params)).toMatchObject({ code });
  });
});
