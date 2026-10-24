import { configFromObject } from '@agentmesh/config';
import type { MemberRecord, OpenInvite, RpcMethodName } from '@agentmesh/protocol';
import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { authorize } from '../auth';
import { actAs, type MeshRpc } from '../rpc';
import { TeamIndex } from '../team';
import { suggest } from './autocomplete';
import { inviteParams, runInvite, runRemove, runUninvite, uninviteReply } from './enrollment';

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
      'enrollment.cancelInvite': { cancelled: true, status: 'cancelled', inviteId: 'inv-abc' },
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

describe('/mesh uninvite', () => {
  it("cancels the person's invite as the admin, keyed by the interaction", async () => {
    const { rpc, calls } = fakeRpc({
      'enrollment.cancelInvite': { cancelled: true, status: 'cancelled', inviteId: 'inv-abc' },
    });
    const i = interaction({ person: ' dana ' }, async () => undefined);
    const reply = await runUninvite(i, actAs(rpc, 'alice', i.id));
    expect(reply).toContain('Cancelled invite **inv-abc** for **dana**');
    expect(calls).toEqual([
      {
        method: 'enrollment.cancelInvite',
        params: { humanId: 'dana' },
        key: 'int-1:enrollment.cancelInvite',
      },
    ]);
  });

  it('passes a refusal through (non-admins are refused by the hub)', async () => {
    const { rpc } = fakeRpc({}, 'enrollment.cancelInvite');
    const i = interaction({ person: 'dana' }, async () => undefined);
    await expect(runUninvite(i, actAs(rpc, 'bob', i.id))).rejects.toThrow('hub said no');
  });

  it.each([
    ['used', 'already joined', '/mesh remove'],
    ['expired', 'had already expired', '/mesh invite'],
    ['already_cancelled', 'was already cancelled', 'inv-abc'],
  ] as const)('explains a %s invite and changes nothing', (status, says, also) => {
    const reply = uninviteReply('dana', { cancelled: false, status, inviteId: 'inv-abc' });
    expect(reply).toContain(says);
    expect(reply).toContain(also);
  });

  it('says when the person has no invite at all', () => {
    expect(uninviteReply('zed', { cancelled: false, status: 'not_found' })).toBe(
      '**zed** has no invite to cancel.',
    );
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
  const open: OpenInvite = {
    inviteId: 'inv-erin',
    humanId: 'erin',
    agentId: 'erin-agent',
    displayName: 'Erin',
    discordUserId: '100000000000000010',
    invitedBy: 'alice',
    expiresAt: '2026-10-20T09:00:00.000Z',
  };
  const listed = (members: MemberRecord[], invites: OpenInvite[] = []) =>
    fakeRpc({ 'enrollment.list': { members, invites } }).rpc;
  const NOW = new Date('2026-10-19T12:00:00.000Z');

  it('lets an enrolled member use the bridge after a refresh, and drops them once removed', async () => {
    const team = new TeamIndex(yaml);
    expect(authorize(team.current, '100000000000000009')).toBeNull();
    expect(await team.refresh(listed([member('active')]))).toBe(1);
    expect(authorize(team.current, '100000000000000009')?.id).toBe('dana');
    expect(team.current.agent('dana-agent')?.owner).toBe('dana');
    await team.refresh(listed([member('revoked')]));
    expect(authorize(team.current, '100000000000000009')).toBeNull();
  });

  it('keeps the previous team when the hub does not answer', async () => {
    const team = new TeamIndex(yaml);
    await team.refresh(listed([member('active')]));
    await expect(team.refresh(fakeRpc({}, 'enrollment.list').rpc)).rejects.toThrow();
    expect(team.current.agent('dana-agent')).toBeDefined();
  });

  // The hub may start after the bridge (compose orders start, not readiness).
  it('keeps asking at startup until the hub answers', async () => {
    const team = new TeamIndex(yaml);
    let attempts = 0;
    const rpc = {
      call: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('no responders');
        return { members: [member('active')], invites: [] };
      },
    } as unknown as MeshRpc;
    expect(await team.load(rpc, { initialDelayMs: 1 })).toBe(1);
    expect(attempts).toBe(3);
    expect(authorize(team.current, '100000000000000009')?.id).toBe('dana');
  });

  it('offers only active invited members to /mesh remove, never mesh.yaml humans', async () => {
    const team = new TeamIndex(yaml);
    const people = () =>
      suggest(team.current, 'mesh', 'remove', 'person', '', team.enrolled(NOW)).map((c) => c.value);
    expect(people()).toEqual([]);
    await team.refresh(listed([member('active')], [open]));
    expect(people()).toEqual(['dana']);
    await team.refresh(listed([member('revoked')]));
    expect(people()).toEqual([]);
  });

  it('offers only open, unexpired invites to /mesh uninvite', async () => {
    const team = new TeamIndex(yaml);
    await team.refresh(listed([member('active')], [open]));
    const people = (now: Date) =>
      suggest(team.current, 'mesh', 'uninvite', 'person', '', team.enrolled(now)).map(
        (c) => c.value,
      );
    expect(people(NOW)).toEqual(['erin']);
    expect(people(new Date('2026-10-20T09:00:00.000Z'))).toEqual([]);
  });
});
