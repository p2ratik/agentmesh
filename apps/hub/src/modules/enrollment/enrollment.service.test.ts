import { createHash, randomBytes } from 'node:crypto';
import { HOUR_MS, MeshError } from '@agentmesh/common';
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
  const inboxes = {
    ensured: [] as string[],
    removed: [] as string[],
    fail: false,
    during: () => {},
  };
  let changes = 0;
  const service = new EnrollmentServiceImpl(h.ctx, {
    inboxes: {
      ensure: async (id) => {
        if (inboxes.fail) throw new Error('nats down');
        inboxes.during();
        inboxes.ensured.push(id);
      },
      remove: async (id) => void inboxes.removed.push(id),
    },
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
  return { ...h, service, inboxes, invite, redeemCode, events, changes: () => changes };
}

const code = (error: unknown) => (error as MeshError).code;

describe('enrollment invites', () => {
  it('issues a code for the configured URL and stores only the secret hash', () => {
    const { invite, ctx } = setup();
    const result = invite();
    const payload = decodeInvite(result.code);
    expect(payload).toMatchObject({ natsUrl: NATS_URL, inviteId: result.inviteId });
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
  ])('refuses ids already used by %s', (_label, params) => {
    const { invite } = setup();
    expect(() => invite(params)).toThrowError(MeshError);
  });

  it('refuses a second open invite for the same person until the first is cancelled', () => {
    const { invite, service } = setup();
    const first = invite();
    expect(() => invite({ discordUserId: '200000000000000009' })).toThrowError(/still open/);
    expect(service.cancelInvite(first.inviteId)).toEqual({ cancelled: true });
    expect(() => invite()).not.toThrow();
  });
});

describe('enrollment redemption', () => {
  it('joins atomically: member, inbox, event, and the index resolves the agent at once', async () => {
    const s = setup();
    expect(() => resolveCaller(s.ctx.index, 'dana-agent')).toThrowError(/Unknown participant/);
    const nkey = newKey();
    const member = await s.redeemCode(s.invite().code, nkey);
    expect(member).toMatchObject({ agentId: 'dana-agent', nkey, status: 'active' });
    expect(resolveCaller(s.ctx.index, 'dana-agent')).toMatchObject({ kind: 'agent' });
    expect(s.ctx.index.agent('dana-agent')?.nkey).toBe(nkey);
    expect(s.inboxes.ensured).toEqual(['dana-agent']);
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
    s.service.cancelInvite(second.inviteId);
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

  it('refuses an invite cancelled while its inbox was being created', async () => {
    const s = setup();
    const { code: invite, inviteId } = s.invite();
    s.inboxes.during = () => void s.service.cancelInvite(inviteId);
    await expect(s.redeemCode(invite)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(s.service.list()).toEqual([]);
    expect(await s.events()).toEqual([]);
  });

  it('keeps the invite unused when the inbox cannot be created, so a retry works', async () => {
    const s = setup();
    const { code: invite } = s.invite();
    s.inboxes.fail = true;
    await expect(s.redeemCode(invite)).rejects.toThrowError('nats down');
    expect(s.ctx.index.agent('dana-agent')).toBeUndefined();
    s.inboxes.fail = false;
    await expect(s.redeemCode(invite)).resolves.toMatchObject({ agentId: 'dana-agent' });
  });
});

describe('enrollment removal', () => {
  it('revokes the member, drops their inbox and stops resolving them', async () => {
    const s = setup();
    await s.redeemCode(s.invite().code);
    expect(await s.service.remove('dana', ALICE)).toEqual({
      removed: true,
      agentIds: ['dana-agent'],
    });
    expect(() => resolveCaller(s.ctx.index, 'dana-agent')).toThrowError(/Unknown participant/);
    expect(s.inboxes.removed).toEqual(['dana-agent']);
    expect(await s.events()).toEqual(['member.joined', 'member.removed']);
    expect(s.service.list()[0]).toMatchObject({ status: 'revoked' });
    expect(await s.service.remove('dana', ALICE)).toEqual({ removed: false, agentIds: [] });
  });

  it('lets a removed member rejoin with a new invite and key', async () => {
    const s = setup();
    await s.redeemCode(s.invite().code);
    await s.service.remove('dana', ALICE);
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
