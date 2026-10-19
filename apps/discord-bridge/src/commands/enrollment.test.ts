import { configFromObject } from '@agentmesh/config';
import type { MemberRecord, RpcMethodName } from '@agentmesh/protocol';
import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { authorize } from '../auth';
import { actAs, type MeshRpc } from '../rpc';
import { TeamIndex } from '../team';
import { inviteParams, runInvite, runRemove } from './enrollment';

const CODE = 'eyJ2IjoxLCJzZWNyZXQiOiJTRUNSRVQifQ';
const INVITE = {
  inviteId: 'inv-abc',
  code: CODE,
  humanId: 'dana',
  agentId: 'dana-agent',
  expiresAt: '2026-10-20T10:00:00.000Z',
};

interface Call {
  method: RpcMethodName;
  params: unknown;
  key: string | undefined;
}

/** A hub stand-in that records calls; `fail` makes one method throw. */
function fakeRpc(results: Partial<Record<RpcMethodName, unknown>>, fail?: RpcMethodName) {
  const calls: Call[] = [];
  const rpc = {
    call: async (method: RpcMethodName, params: unknown, options?: { idempotencyKey?: string }) => {
      calls.push({ method, params, key: options?.idempotencyKey });
      if (method === fail) throw new Error('hub said no');
      return results[method];
    },
  } as unknown as MeshRpc;
  return { rpc, calls };
}

function interaction(options: Record<string, string>, dm: (text: string) => Promise<void>) {
  const user = {
    id: '100000000000000009',
    username: 'dana_d',
    globalName: 'Dana',
    send: async ({ content }: { content: string }) => dm(content),
  };
  return {
    id: 'int-1',
    user: { username: 'alice' },
    options: {
      getUser: () => user,
      getString: (name: string) => options[name] ?? null,
    },
  } as unknown as ChatInputCommandInteraction;
}

describe('/mesh invite', () => {
  it('maps options, defaulting the display name to the Discord name', () => {
    const user = { id: '100000000000000009', globalName: 'Dana', username: 'dana_d' };
    expect(
      inviteParams({
        user,
        id: ' dana ',
        name: null,
        roles: null,
        skills: 'api, backend',
        agent: null,
      }),
    ).toEqual({
      humanId: 'dana',
      displayName: 'Dana',
      discordUserId: '100000000000000009',
      roles: [],
      skills: ['api', 'backend'],
    });
  });

  it('DMs the code and never puts it in the reply', async () => {
    const { rpc, calls } = fakeRpc({ 'enrollment.invite': INVITE });
    const dms: string[] = [];
    const i = interaction({ id: 'dana' }, async (text) => void dms.push(text));
    const reply = await runInvite(i, actAs(rpc, 'alice', i.id));
    expect(dms[0]).toContain(CODE);
    expect(dms[0]).toContain('/agentmesh:join');
    expect(reply).toContain('inv-abc');
    expect(reply).not.toContain(CODE);
    expect(calls.map((c) => c.method)).toEqual(['enrollment.invite']);
  });

  it('cancels the invite when the DM fails, without revealing the code', async () => {
    const { rpc, calls } = fakeRpc({
      'enrollment.invite': INVITE,
      'enrollment.cancelInvite': { cancelled: true },
    });
    const i = interaction({ id: 'dana' }, async () => {
      throw new Error('Cannot send messages to this user');
    });
    const reply = await runInvite(i, actAs(rpc, 'alice', i.id));
    expect(reply).toContain('was cancelled');
    expect(reply).not.toContain(CODE);
    expect(calls[1]).toMatchObject({
      method: 'enrollment.cancelInvite',
      params: { inviteId: 'inv-abc' },
    });
    // One interaction, two calls: each gets its own idempotency key.
    expect(calls.map((c) => c.key)).toEqual([
      'int-1:enrollment.invite',
      'int-1:enrollment.cancelInvite',
    ]);
  });

  it('says so when even the cancellation fails', async () => {
    const { rpc } = fakeRpc({ 'enrollment.invite': INVITE }, 'enrollment.cancelInvite');
    const i = interaction({ id: 'dana' }, async () => {
      throw new Error('closed DMs');
    });
    expect(await runInvite(i, actAs(rpc, 'alice', i.id))).toContain(
      'cancelling invite **inv-abc** failed',
    );
  });
});

describe('/mesh remove', () => {
  it('reports what was removed', async () => {
    const { rpc } = fakeRpc({ 'enrollment.remove': { removed: true, agentIds: ['dana-agent'] } });
    const i = interaction({ person: 'dana' }, async () => undefined);
    expect(await runRemove(i, actAs(rpc, 'alice', i.id))).toContain('dana-agent disconnected');
  });
});

describe('TeamIndex', () => {
  const yaml = configFromObject({
    version: 1,
    mesh: { name: 'acme' },
    humans: [{ id: 'alice', displayName: 'Alice', discordUserId: '100000000000000001' }],
  }).config;
  const member = (status: MemberRecord['status']): MemberRecord => ({
    humanId: 'dana',
    agentId: 'dana-agent',
    displayName: 'Dana',
    discordUserId: '100000000000000009',
    roles: [],
    skills: ['api'],
    nkey: `U${'A'.repeat(55)}`,
    status,
    invitedBy: 'alice',
    joinedAt: '2026-10-19T09:00:00.000Z',
    removedAt: null,
  });

  it('lets an enrolled member use the bridge after a refresh, and drops them once removed', async () => {
    const team = new TeamIndex(yaml);
    expect(authorize(team.current, '100000000000000009')).toBeNull();
    expect(
      await team.refresh(fakeRpc({ 'enrollment.list': { members: [member('active')] } }).rpc),
    ).toBe(1);
    expect(authorize(team.current, '100000000000000009')?.id).toBe('dana');
    expect(team.current.agent('dana-agent')?.owner).toBe('dana');
    await team.refresh(fakeRpc({ 'enrollment.list': { members: [member('revoked')] } }).rpc);
    expect(authorize(team.current, '100000000000000009')).toBeNull();
  });

  it('keeps the previous team when the hub does not answer', async () => {
    const team = new TeamIndex(yaml);
    await team.refresh(fakeRpc({ 'enrollment.list': { members: [member('active')] } }).rpc);
    await expect(team.refresh(fakeRpc({}, 'enrollment.list').rpc)).rejects.toThrow();
    expect(team.current.agent('dana-agent')).toBeDefined();
  });
});
