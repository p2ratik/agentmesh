import { ManualClock, MeshError, MINUTE_MS } from '@agentmesh/common';
import { encodeInvite, type InvitePayload, type MemberRecord } from '@agentmesh/protocol';
import { createAccount, createServer, createUser, type KeyPair } from '@nats-io/nkeys';
import { describe, expect, it } from 'vitest';
import type { RedeemInput } from '../../contracts';
import { type AuthRequest, decide, serverRequest } from './decide';
import { signedNonce, signJwt, verifiedClaims } from './jwt';
import { FailureLimiter } from './limiter';

const NOW = new Date('2026-10-16T09:00:00.000Z');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const utf8 = (text: string) => new TextEncoder().encode(text);
const sign = (kp: KeyPair, nonce: string) => b64(kp.sign(utf8(nonce)));
const SECRET = 'A'.repeat(43);
// Client-side hints the callout never reads; included so the code decodes with or without them.
const HINTS = { agentId: 'dana-agent', prefix: 'mesh' };
const invite = (inviteId = 'inv-1') =>
  encodeInvite({
    v: 1,
    natsUrl: 'tls://mesh.example.com:4222',
    inviteId,
    secret: SECRET,
    ...HINTS,
  } as InvitePayload);

function request(user: KeyPair, opts: { token?: string; signer?: KeyPair } = {}): AuthRequest {
  return {
    server_id: { id: 'NSERVER' },
    user_nkey: 'UGENERATED',
    client_info: { host: '203.0.113.7', id: 42, nonce: 'nonce-1' },
    connect_opts: {
      nkey: user.getPublicKey(),
      sig: sign(opts.signer ?? user, 'nonce-1'),
      ...(opts.token ? { auth_token: opts.token } : {}),
    },
  };
}

function deps(
  options: { known?: Record<string, string>; redeemOk?: boolean; limit?: number } = {},
) {
  const clock = new ManualClock(NOW);
  const redeemed: RedeemInput[] = [];
  return {
    clock,
    redeemed,
    deps: {
      agentForKey: (nkey: string) => options.known?.[nkey] ?? null,
      redeem: async (input: RedeemInput) => {
        redeemed.push(input);
        if (!options.redeemOk) throw new MeshError('unauthenticated', 'no');
        return { agentId: 'dana-agent' } as MemberRecord;
      },
      limiter: new FailureLimiter(options.limit ?? 5, clock),
    },
  };
}

describe('callout JWTs', () => {
  it('signs JWTs its own verifier accepts, and rejects tampering', () => {
    const issuer = createAccount();
    const jwt = signJwt(issuer, { sub: 'UX', nats: { type: 'user' } }, NOW);
    expect(verifiedClaims(jwt)).toMatchObject({
      iss: issuer.getPublicKey(),
      sub: 'UX',
      iat: 1792141200,
    });
    const [head, , sig] = jwt.split('.');
    const forged = Buffer.from(JSON.stringify({ iss: issuer.getPublicKey(), sub: 'UY' })).toString(
      'base64url',
    );
    expect(verifiedClaims(`${head}.${forged}.${sig}`)).toBeNull();
    expect(verifiedClaims('not.a.jwt')).toBeNull();
    expect(verifiedClaims(`${jwt}.extra`)).toBeNull();
  });

  it('signs byte for byte like nkeys and accepts what nkeys signs', () => {
    const issuer = createAccount();
    const [head, payload, sig] = signJwt(issuer, { sub: 'UX' }, NOW).split('.');
    expect(sig).toBe(b64(issuer.sign(utf8(`${head}.${payload}`))));
    const server = createServer();
    const body = `${head}.${b64(utf8(JSON.stringify({ iss: server.getPublicKey() })))}`;
    const byNkeys = `${body}.${b64(server.sign(utf8(body)))}`;
    expect(verifiedClaims(byNkeys)).toEqual({ iss: server.getPublicKey() });
    expect(verifiedClaims(`${body}.${b64(createServer().sign(utf8(body)))}`)).toBeNull();
  });

  it('verifies without pure-JS ed25519, so a bogus connect stays cheap', () => {
    // nkeys (tweetnacl) needs ~8 ms per verify: 100 of them take most of a second.
    const user = createUser();
    const [nkey, sig] = [user.getPublicKey(), sign(user, 'nonce')];
    const started = performance.now();
    for (let i = 0; i < 100; i++) expect(signedNonce(nkey, 'nonce', sig)).toBe(true);
    expect(performance.now() - started).toBeLessThan(300);
  });

  it('accepts only the server-signed request whose issuer is the server', () => {
    const server = createServer();
    const nats = { server_id: { id: server.getPublicKey() }, user_nkey: 'UGENERATED' };
    expect(serverRequest(verifiedClaims(signJwt(server, { nats }, NOW)))).toMatchObject(nats);
    const impostor = createServer();
    expect(serverRequest(verifiedClaims(signJwt(impostor, { nats }, NOW)))).toBeNull();
    expect(serverRequest(null)).toBeNull();
  });

  it('checks the nonce signature against the presented key', () => {
    const user = createUser();
    expect(signedNonce(user.getPublicKey(), 'n', sign(user, 'n'))).toBe(true);
    expect(signedNonce(user.getPublicKey(), 'n', sign(createUser(), 'n'))).toBe(false);
    expect(signedNonce(createAccount().getPublicKey(), 'n', 'x')).toBe(false);
    expect(signedNonce(`U${'A'.repeat(55)}`, 'n', 'x')).toBe(false);
  });
});

describe('callout decisions', () => {
  it('refuses a forged signature before looking at the key or the invite', async () => {
    const dana = createUser();
    const { deps: d, redeemed } = deps({ known: { [dana.getPublicKey()]: 'dana-agent' } });
    const forged = request(dana, { token: invite(), signer: createUser() });
    expect(await decide(forged, d)).toEqual({ refused: 'bad nkey signature' });
    const unsigned = { ...forged, connect_opts: { nkey: dana.getPublicKey() } };
    expect(await decide(unsigned, d)).toEqual({ refused: 'no nkey signature' });
    expect(redeemed).toEqual([]);
  });

  it('admits a known key without touching the invite', async () => {
    const alice = createUser();
    const { deps: d, redeemed } = deps({ known: { [alice.getPublicKey()]: 'alice-agent' } });
    expect(await decide(request(alice, { token: invite() }), d)).toEqual({
      agentId: 'alice-agent',
    });
    expect(redeemed).toEqual([]);
  });

  it('refuses an unknown key without an invite, and redeems one with it', async () => {
    const dana = createUser();
    expect(await decide(request(dana), deps().deps)).toEqual({ refused: 'unknown key' });
    const { deps: d, redeemed } = deps({ redeemOk: true });
    expect(await decide(request(dana, { token: invite() }), d)).toEqual({ agentId: 'dana-agent' });
    expect(redeemed).toEqual([{ inviteId: 'inv-1', secret: SECRET, nkey: dana.getPublicKey() }]);
  });

  it('rate-limits failed redemptions per invite and per address, for one minute', async () => {
    const { deps: d, redeemed, clock } = deps({ limit: 2 });
    for (let i = 0; i < 2; i++) await decide(request(createUser(), { token: invite() }), d);
    const blocked = await decide(request(createUser(), { token: invite('inv-2') }), d);
    expect(blocked).toEqual({ refused: 'too many failed redemptions from this address' });
    expect(redeemed).toHaveLength(2);

    const elsewhere = request(createUser(), { token: invite() });
    elsewhere.client_info = { ...elsewhere.client_info, host: '198.51.100.9' };
    expect(await decide(elsewhere, d)).toEqual({ refused: 'too many failed redemptions' });

    clock.advance(MINUTE_MS);
    await decide(request(createUser(), { token: invite() }), d);
    expect(redeemed).toHaveLength(3);
  });

  it('counts malformed invite codes against the address', async () => {
    const { deps: d } = deps({ limit: 1 });
    expect(await decide(request(createUser(), { token: 'garbage' }), d)).toEqual({
      refused: 'malformed invite',
    });
    expect(await decide(request(createUser(), { token: invite() }), d)).toMatchObject({
      refused: expect.stringMatching(/address/),
    });
  });
});
