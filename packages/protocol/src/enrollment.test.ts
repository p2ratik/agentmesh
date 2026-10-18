import { MeshError } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite, type InvitePayload } from './enrollment';
import { RPC_METHODS } from './rpc';

const payload: InvitePayload = {
  v: 1,
  natsUrl: 'tls://mesh.example.com:4222',
  inviteId: 'inv-01J9ZK3Q8X7M2N4P6R8T0V2W4Y',
  secret: 'A'.repeat(42) + 'Q',
};

const encodeRaw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('invite codes', () => {
  it('round-trips, tolerating whitespace from copy-paste', () => {
    const code = encodeInvite(payload);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeInvite(`  ${code}\n`)).toEqual(payload);
  });

  it('refuses to encode an invalid payload', () => {
    expect(() => encodeInvite({ ...payload, secret: 'short' })).toThrow();
  });

  it.each([
    ['empty', ''],
    ['not base64 json', 'hello'],
    ['json but wrong shape', encodeRaw({ hello: 'world' })],
    ['unknown version', encodeRaw({ ...payload, v: 2 })],
    ['http url', encodeRaw({ ...payload, natsUrl: 'https://mesh.example.com' })],
    ['bad invite id', encodeRaw({ ...payload, inviteId: 'task-1' })],
    ['short secret', encodeRaw({ ...payload, secret: 'abc' })],
    ['oversized', 'A'.repeat(5000)],
  ])('rejects %s with invalid_request and never echoes the input', (_label, code) => {
    let error: unknown;
    try {
      decodeInvite(code);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MeshError);
    expect((error as MeshError).code).toBe('invalid_request');
    if (code) expect((error as MeshError).message).not.toContain(code);
  });
});

describe('enrollment RPC contracts', () => {
  it('lets only admins invite, cancel and remove; only services list', () => {
    for (const name of [
      'enrollment.invite',
      'enrollment.cancelInvite',
      'enrollment.remove',
    ] as const) {
      expect(RPC_METHODS[name].callers).toEqual(['human']);
      expect(RPC_METHODS[name].requiresRole).toBe('admin');
    }
    expect(RPC_METHODS['enrollment.list'].callers).toEqual(['service']);
  });

  it('requires the Discord account the invite is bound to', () => {
    const params = RPC_METHODS['enrollment.invite'].params;
    expect(params.safeParse({ humanId: 'dana', displayName: 'Dana' }).success).toBe(false);
    const ok = params.parse({ humanId: 'dana', displayName: 'Dana', discordUserId: '123456789' });
    expect(ok).toMatchObject({ roles: [], skills: [] });
  });
});
