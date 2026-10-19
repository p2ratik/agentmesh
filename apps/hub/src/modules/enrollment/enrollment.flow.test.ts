import { createLogger, ManualClock } from '@agentmesh/common';
import { decodeInvite } from '@agentmesh/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../app';
import { MemoryPorts } from '../../ports';
import { testTeamConfig } from '../../testing/fixtures';

const DANA_KEY = `U${'D'.repeat(55)}`;
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

async function start() {
  const ports = new MemoryPorts();
  hub = await createHub({
    loaded: testTeamConfig({
      hub: { http: { enabled: false } },
      enrollment: { natsUrl: 'tls://mesh.example.com:4222' },
    }),
    dataDir: ':memory:',
    nats: null,
    ports: { delivery: ports, events: ports },
    clock: new ManualClock('2026-10-16T09:00:00.000Z'),
    logger: createLogger('hub-test', { level: 'silent', destination: 'stderr' }),
  });
  await hub.start();
  const h = hub;
  const call = async <T = Record<string, unknown>>(
    caller: string,
    method: string,
    params: unknown = {},
    extra: { actAs?: string; idempotencyKey?: string } = {},
  ) => (await h.dispatch({ caller, method, ...extra }, params)) as T;
  return { hub: h, ports, call };
}

describe('enrollment through the hub (no NATS)', () => {
  it('a joined agent works with no restart, and a removed one is refused', async () => {
    const { hub, ports, call } = await start();
    const invite = await call<{ code: string }>(
      'discord-bridge',
      'enrollment.invite',
      { humanId: 'dana', displayName: 'Dana', discordUserId: '200000000000000001' },
      { actAs: 'alice', idempotencyKey: 'interaction-1:enrollment.invite' },
    );
    // The invite result never reaches the idempotency cache.
    const cached = hub.context.db.all<{ response: string }>('SELECT response FROM rpc_idempotency');
    expect(JSON.stringify(cached)).not.toContain(invite.code);

    const { inviteId, secret } = decodeInvite(invite.code);
    await hub.services.enrollment.redeem({ inviteId, secret, nkey: DANA_KEY });

    const hello = await call<{ self: { id: string } }>('dana-agent', 'session.hello', {
      clientVersion: 'test',
    });
    expect(hello.self.id).toBe('dana-agent');
    const peers = await call<{ peers: Array<{ id: string }> }>('alice-agent', 'peers.list', {});
    expect(peers.peers.map((p) => p.id)).toContain('dana-agent');
    await call('alice-agent', 'message.send', { kind: 'ask', to: ['dana-agent'], body: 'Hi Dana' });
    await hub.tick();
    expect(ports.deliveredTo('dana-agent').map((m) => m.body)).toEqual(['Hi Dana']);

    const listed = await call<{ members: Array<{ agentId: string }> }>(
      'discord-bridge',
      'enrollment.list',
    );
    expect(listed.members.map((m) => m.agentId)).toEqual(['dana-agent']);
    await expect(call('hermes', 'enrollment.list')).rejects.toMatchObject({ code: 'forbidden' });

    await call('discord-bridge', 'enrollment.remove', { humanId: 'dana' }, { actAs: 'alice' });
    await expect(
      call('dana-agent', 'session.hello', { clientVersion: 'test' }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await hub.tick();
    expect(ports.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['member.joined', 'member.removed']),
    );
  });

  it('lets only admins invite', async () => {
    const { call } = await start();
    const params = { humanId: 'dana', displayName: 'Dana', discordUserId: '200000000000000001' };
    await expect(
      call('discord-bridge', 'enrollment.invite', params, { actAs: 'bob' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lists open invites to the bridge and lets only admins cancel them', async () => {
    const { call } = await start();
    const params = { humanId: 'dana', displayName: 'Dana', discordUserId: '200000000000000001' };
    const { inviteId } = await call<{ inviteId: string }>(
      'discord-bridge',
      'enrollment.invite',
      params,
      { actAs: 'alice' },
    );
    const listed = await call<{ invites: Array<{ inviteId: string }> }>(
      'discord-bridge',
      'enrollment.list',
    );
    expect(listed.invites.map((i) => i.inviteId)).toEqual([inviteId]);

    const cancel = (actAs: string) =>
      call('discord-bridge', 'enrollment.cancelInvite', { humanId: 'dana' }, { actAs });
    await expect(cancel('bob')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await cancel('alice')).toMatchObject({ cancelled: true, status: 'cancelled' });
    await expect(
      call('discord-bridge', 'enrollment.invite', params, { actAs: 'alice' }),
    ).resolves.toMatchObject({ humanId: 'dana' });
  });
});
