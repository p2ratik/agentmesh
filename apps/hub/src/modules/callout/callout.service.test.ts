import type { NatsConnection } from '@agentmesh/bus';
import { type Logger, MINUTE_MS } from '@agentmesh/common';
import { createAccount, createCurve, createServer, createUser, type KeyPair } from '@nats-io/nkeys';
import { describe, expect, it } from 'vitest';
import type { EnrollmentService } from '../../contracts';
import { testTeamConfig } from '../../testing/fixtures';
import { createTestHarness } from '../../testing/harness';
import { CalloutService } from './callout.service';
import { type Claims, signJwt, verifiedClaims } from './jwt';

const utf8 = (text: string) => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const NONCE = 'nonce-1';

/** A callout fed sealed, server-signed requests the way nats-server sends them. */
function setup(overrides: Record<string, unknown> = {}) {
  const h = createTestHarness(testTeamConfig(overrides));
  const logs: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const record = (level: string) => (fields: Record<string, unknown>) => {
    logs.push({ level, fields });
  };
  h.ctx.logger = {
    warn: record('warn'),
    debug: record('debug'),
    info: record('info'),
    error: record('error'),
  } as unknown as Logger;
  const keys = { issuer: createAccount(), xkey: createCurve() };
  const service = new CalloutService(h.ctx, {
    keys,
    enrollment: {} as EnrollmentService,
    sys: {} as NatsConnection,
  });
  const server = createServer();
  const serverXkey = createCurve();

  /** The `nats` claim of the hub's answer, or null when the request was left unanswered. */
  const connect = async (
    host: string,
    connectOpts: Record<string, unknown> = {},
    cid = 1,
  ): Promise<Claims | null> => {
    const nats = {
      server_id: { id: server.getPublicKey() },
      user_nkey: 'UGENERATED',
      client_info: { host, id: cid, nonce: NONCE },
      connect_opts: connectOpts,
    };
    const request = signJwt(server, { nats }, h.clock.now());
    let answer: Claims | null = null;
    await service.handle({
      data: serverXkey.seal(utf8(request), keys.xkey.getPublicKey()),
      headers: { get: () => serverXkey.getPublicKey() },
      respond: (data) => {
        const opened = serverXkey.open(data, keys.xkey.getPublicKey()) as Uint8Array;
        answer = verifiedClaims(new TextDecoder().decode(opened))?.nats as Claims;
        return true;
      },
    });
    return answer;
  };
  const signed = (user: KeyPair) => ({
    nkey: user.getPublicKey(),
    sig: b64(user.sign(utf8(NONCE))),
  });
  return { ...h, service, connect, signed, logs };
}

describe('callout connect budget', () => {
  it('leaves connects over the per-address budget unanswered until the minute is over', async () => {
    const s = setup({ enrollment: { connectAttemptsPerMinute: 3 } });
    for (let i = 0; i < 3; i++) {
      expect(await s.connect('203.0.113.7')).toMatchObject({ error: 'not authorized' });
    }
    expect(await s.connect('203.0.113.7')).toBeNull();
    expect(await s.connect('198.51.100.9')).toMatchObject({ error: 'not authorized' });
    s.clock.advance(MINUTE_MS);
    expect(await s.connect('203.0.113.7')).toMatchObject({ error: 'not authorized' });
  });

  it('counts admitted connects too, since each costs the same signature work', async () => {
    const alice = createUser();
    const s = setup({
      enrollment: { connectAttemptsPerMinute: 2 },
      agents: [{ id: 'alice-agent', owner: 'alice', nkey: alice.getPublicKey() }],
    });
    expect(await s.connect('203.0.113.7', s.signed(alice))).toHaveProperty('jwt');
    expect(await s.connect('203.0.113.7', s.signed(alice))).toHaveProperty('jwt');
    expect(await s.connect('203.0.113.7', s.signed(alice))).toBeNull();
  });
});

describe('callout refusal logs', () => {
  it('folds refusals per address, whatever key each attempt brings', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) await s.connect('203.0.113.7', s.signed(createUser()));
    expect(s.logs.map((l) => l.level)).toEqual(['warn', 'debug', 'debug', 'debug', 'debug']);
    expect(s.logs[0]?.fields).toMatchObject({ reason: 'unknown key', host: '203.0.113.7' });
  });

  it('never logs a client-chosen string that is not a well-formed nkey', async () => {
    const s = setup();
    const user = createUser();
    await s.connect('203.0.113.7', { nkey: `U${'X'.repeat(4000)}`, sig: 'x' });
    await s.connect('198.51.100.9', s.signed(user));
    expect(s.logs[0]?.fields).toEqual({
      reason: 'bad nkey signature',
      host: '203.0.113.7',
      cid: 1,
    });
    expect(s.logs[1]?.fields).toMatchObject({ reason: 'unknown key', nkey: user.getPublicKey() });
  });
});
