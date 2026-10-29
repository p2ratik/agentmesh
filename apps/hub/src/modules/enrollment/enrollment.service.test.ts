import { createHash, randomBytes } from 'node:crypto';
import { HOUR_MS, MeshError, MINUTE_MS } from '@agentmesh/common';
import { decodeInvite } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../../contracts';
import { resolveCaller } from '../../rpc/actor';
import { testTeamConfig } from '../../testing/fixtures';
import { createTestHarness } from '../../testing/harness';
import { EnrollmentServiceImpl } from './enrollment.service';

const ALICE: Actor = { id: 'alice', kind: 'human', roles: ['admin'] };
const NATS_URL = 'tls://mesh.example.com:4222';
const DANA = { humanId: 'dana', displayName: 'Dana', discordUserId: '200000000000000001' };
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** The shape of a NATS user public key; the callout, not the service, checks signatures. */
const newKey = () => `U${Array.from(randomBytes(55), (b) => BASE32[b % 32]).join('')}`;

function setup(enrollment: Record<string, unknown> = { natsUrl: NATS_URL }) {
  const h = createTestHarness(testTeamConfig({ enrollment }));
  let changes = 0;
  const service = new EnrollmentServiceImpl(h.ctx, {
    onMembersChanged: () => {
      changes += 1;
    },
  });
  const invite = (params: Partial<typeof DANA> & Record<string, unknown> = {}) =>
    service.invite({ ...DANA, roles: [], skills: ['backend'], ...params }, ALICE);
  const redeemCode = (code: string, nkey = newKey()) => {
    const { inviteId, secret } = decodeInvite(code);
    return service.redeem({ inviteId, secret, nkey });
  };
  const events = async () => {
    await h.outbox.flush();
    return h.ports.events.map((e) => e.type);
  };
  return { ...h, service, invite, redeemCode, events, changes: () => changes };
}

const code = (error: unknown) => (error as MeshError).code;

describe('enrollment invites', () => {
  it('issues a code for the configured URL and stores only the secret hash', () => {
    const { invite, ctx } = setup();
    const result = invite();
    const payload = decodeInvite(result.code);
    expect(payload).toMatchObject({
      natsUrl: NATS_URL,
      inviteId: result.inviteId,
      agentId: 'dana-agent',
      prefix: ctx.loaded.config.mesh.prefix,
    });
    expect(result).toMatchObject({ humanId: 'dana', agentId: 'dana-agent' });
    const row = ctx.db.get<{ secret_sha256: string }>('SELECT * FROM enrollment_invites');
    const dump = JSON.stringify(ctx.db.all('SELECT * FROM enrollment_invites'));
    expect(dump).not.toContain(payload.secret);
    expect(row?.secret_sha256).toBe(createHash('sha256').update(payload.secret).digest('hex'));
  });

  it('refuses without enrollment.natsUrl', () => {
    expect(() => setup({}).invite()).toThrowError(/enrollment\.natsUrl/);
  });

  it.each([
    ['a mesh.yaml human', { humanId: 'bob', agentId: 'bob-2' }],
    ['a mesh.yaml agent', { agentId: 'alice-agent' }],
    ['a mesh.yaml Discord account', { discordUserId: '100000000000000002' }],
    ['a mesh.yaml service', { agentId: 'discord-bridge' }],
    ['the hub', { humanId: 'hub' }],
    ['the human themself', { agentId: 'dana' }],
  ])('refuses ids already used by %s', (_label, params) => {
    const { invite } = setup();
    expect(() => invite(params)).toThrowError(MeshError);
  });

  it("refuses an active member's ids and Discord account, and a removed member's agent id", async () => {
    const s = setup();
    await s.redeemCode(s.invite().code);
    expect(() => s.invite({ humanId: 'dan', agentId: 'dana-agent' })).toThrowError(/already/);
    expect(() => s.invite({ humanId: 'dan' })).toThrowError(/Discord account/);
    await s.service.remove('dana', ALICE);
    const reuse = { humanId: 'dan', agentId: 'dana-agent', discordUserId: '200000000000000002' };
    expect(() => s.invite(reuse)).toThrowError(/removed member/);
  });

  it('refuses a second open invite for the same person until the first is cancelled', () => {
    const { invite, service } = setup();
    const first = invite();
    expect(() => invite({ discordUserId: '200000000000000009' })).toThrowError(/still open/);
    expect(service.cancelInvite({ inviteId: first.inviteId }, ALICE)).toMatchObject({
      cancelled: true,
      status: 'cancelled',
    });
    expect(() => invite()).not.toThrow();
  });
});

describe('cancelling invites', () => {
  it("cancels a person's open invite once, then lets them be invited again", () => {
    const { invite, service } = setup();
    const { inviteId } = invite();
    expect(service.cancelInvite({ humanId: 'dana' }, ALICE)).toEqual({
      cancelled: true,
      status: 'cancelled',
      inviteId,
    });
    expect(service.cancelInvite({ humanId: 'dana' }, ALICE)).toEqual({
      cancelled: false,
      status: 'already_cancelled',
      inviteId,
    });
    expect(service.openInvites()).toEqual([]);
    expect(invite().inviteId).not.toBe(inviteId);
  });

  it('reports a redeemed, an expired or a missing invite and changes nothing', async () => {
    const s = setup();
    const used = s.invite();
    await s.redeemCode(used.code);
    expect(s.service.cancelInvite({ humanId: 'dana' }, ALICE)).toMatchObject({
      cancelled: false,
      status: 'used',
    });
    expect(s.service.list()[0]?.status).toBe('active');

    s.invite({ humanId: 'eve', discordUserId: '200000000000000005' });
    s.clock.advance(25 * HOUR_MS);
    expect(s.service.cancelInvite({ humanId: 'eve' }, ALICE)).toMatchObject({ status: 'expired' });
    expect(s.service.cancelInvite({ humanId: 'zed' }, ALICE)).toEqual({
      cancelled: false,
      status: 'not_found',
    });
  });

  it('lists open invites for the bridge without the code or its hash', () => {
    const { invite, service } = setup();
    const { code: secretCode, inviteId, expiresAt } = invite();
    const listed = service.openInvites();
    expect(listed).toEqual([
      {
        inviteId,
        humanId: 'dana',
        agentId: 'dana-agent',
        displayName: 'Dana',
        discordUserId: DANA.discordUserId,
        invitedBy: 'alice',
        expiresAt,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(decodeInvite(secretCode).secret);
  });
});

describe('enrollment redemption', () => {
  it('joins atomically: member, event, and the index resolves the agent at once', async () => {
    const s = setup();
    expect(() => resolveCaller(s.ctx.index, 'dana-agent')).toThrowError(/Unknown participant/);
    const nkey = newKey();
    const member = await s.redeemCode(s.invite().code, nkey);
    expect(member).toMatchObject({ agentId: 'dana-agent', nkey, status: 'active' });
    expect(resolveCaller(s.ctx.index, 'dana-agent')).toMatchObject({ kind: 'agent' });
    expect(s.ctx.index.agent('dana-agent')?.nkey).toBe(nkey);
    expect(await s.events()).toContain('member.joined');
    expect(s.changes()).toBe(1);
  });

  it('is single use, even for two redemptions racing on one invite', async () => {
    const s = setup();
    const { code: invite } = s.invite();
    const results = await Promise.allSettled([s.redeemCode(invite), s.redeemCode(invite)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(s.redeemCode(invite)).rejects.toThrowError(MeshError);
    expect(s.service.list()).toHaveLength(1);
  });

  it('refuses a wrong secret, an expired or cancelled invite, and a reused key, all alike', async () => {
    const s = setup();
    const first = s.invite();
    const { inviteId } = decodeInvite(first.code);
    const wrong = s.service.redeem({ inviteId, secret: 'x'.repeat(43), nkey: newKey() });
    await expect(wrong).rejects.toMatchObject({ code: 'unauthenticated' });

    s.clock.advance(25 * HOUR_MS);
    await expect(s.redeemCode(first.code)).rejects.toMatchObject({ code: 'unauthenticated' });

    const second = s.invite();
    s.service.cancelInvite({ inviteId: second.inviteId }, ALICE);
    await expect(s.redeemCode(second.code)).rejects.toMatchObject({ code: 'unauthenticated' });

    const key = newKey();
    await s.redeemCode(s.invite({ humanId: 'fay', discordUserId: '200000000000000006' }).code, key);
    const eve = s.invite({ humanId: 'eve', discordUserId: '200000000000000005' });
    await expect(s.redeemCode(eve.code, key)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(s.redeemCode(eve.code, 'not-a-key')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(s.service.list().map((m) => m.humanId)).toEqual(['fay']);
  });
});

describe('enrollment removal', () => {
  it('revokes the member and stops resolving them', async () => {
    const s = setup();
    await s.redeemCode(s.invite().code);
    expect(await s.service.remove('dana', ALICE)).toEqual({
      removed: true,
      agentIds: ['dana-agent'],
    });
    expect(() => resolveCaller(s.ctx.index, 'dana-agent')).toThrowError(/Unknown participant/);
    expect(await s.events()).toEqual(['member.joined', 'member.removed']);
    expect(s.service.list()[0]).toMatchObject({ status: 'revoked' });
    expect(await s.service.remove('dana', ALICE)).toEqual({ removed: false, agentIds: [] });
  });

  it('refuses their agent id until connections from before the removal have expired', async () => {
    const s = setup({ natsUrl: NATS_URL, userJwtTtlMinutes: 30 });
    await s.redeemCode(s.invite().code);
    await s.service.remove('dana', ALICE);
    s.clock.advance(20 * MINUTE_MS);
    expect(() => s.invite()).toThrowError(/removed less than 30 minutes ago.*Wait 10 minutes/);
    const other = s.invite({ agentId: 'dana-2' });
    s.service.cancelInvite({ inviteId: other.inviteId }, ALICE);
    s.clock.advance(10 * MINUTE_MS);
    expect(s.invite().agentId).toBe('dana-agent');
  });

  it('lets a removed member rejoin with a new invite and key', async () => {
    const s = setup();
    await s.redeemCode(s.invite().code);
    await s.service.remove('dana', ALICE);
    s.clock.advance(HOUR_MS);
    const again = await s.redeemCode(s.invite().code);
    expect(again.status).toBe('active');
    expect(s.service.list()).toHaveLength(1);
  });

  it('refuses to remove someone defined in mesh.yaml', async () => {
    const error = await setup()
      .service.remove('bob', ALICE)
      .catch((e: unknown) => e);
    expect(code(error)).toBe('invalid_request');
  });
});
