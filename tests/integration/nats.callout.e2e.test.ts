import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { natsUsersFromConfig } from '@agentmesh/bus';
import { createAccount, createCurve, createUser, type KeyPair } from '@nats-io/nkeys';
import { connect, type NatsConnection, nkeyAuthenticator } from '@nats-io/transport-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderNatsConfig } from '../../apps/cli/src/render/nats-config';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';

/**
 * The account-mode config `agentmesh nats-config --auth-callout` renders, run
 * by a real nats-server with no callout service: static users connect with
 * their own permissions only, and agents are refused (fail closed).
 * Needs AGENTMESH_TEST_NATS_BIN=<path to nats-server>.
 */
const NATS_BIN = process.env.AGENTMESH_TEST_NATS_BIN ?? '';
const PORT = 4900 + Math.floor(Date.now() % 500);
const URL = `nats://127.0.0.1:${PORT}`;
const PREFIX = 'callout';

const key = (kp: KeyPair) => ({ kp, pub: kp.getPublicKey(), seed: kp.getSeed() });

/** Connects once, without retries; resolves to the error text when refused. */
async function tryConnect(seed: Uint8Array): Promise<NatsConnection | string> {
  try {
    return await connect({
      servers: URL,
      authenticator: nkeyAuthenticator(seed),
      reconnect: false,
      timeout: 3000,
    });
  } catch (error) {
    return String(error);
  }
}

describe.skipIf(!NATS_BIN || !existsSync(NATS_BIN))('auth-callout NATS config', () => {
  const k = {
    hub: key(createUser()),
    bridge: key(createUser()),
    agent: key(createUser()),
    issuer: key(createAccount()),
    xkey: key(createCurve()),
    sys: key(createUser()),
  };
  const loaded = testTeamConfig({
    mesh: { name: 'callout-e2e', prefix: PREFIX },
    hub: { nkey: k.hub.pub },
    agents: [{ id: 'alice-agent', owner: 'alice', skills: ['backend'], nkey: k.agent.pub }],
    areas: [],
    services: [{ id: 'discord-bridge', role: 'bridge', canActAsHumans: true, nkey: k.bridge.pub }],
  });
  let server: ChildProcess;
  const open: NatsConnection[] = [];

  async function connected(seed: Uint8Array): Promise<NatsConnection> {
    const nc = await tryConnect(seed);
    if (typeof nc === 'string') throw new Error(nc);
    open.push(nc);
    return nc;
  }

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-callout-'));
    const conf = renderNatsConfig({
      meshName: 'callout-e2e',
      prefix: PREFIX,
      users: natsUsersFromConfig(loaded.config),
      dev: false,
      maxFileStore: '256MB',
      allowMissing: false,
      authCallout: { issuer: k.issuer.pub, xkey: k.xkey.pub, sysNkey: k.sys.pub },
    })
      .text.replace('port: 4222', `port: ${PORT}`)
      .replace('http: "127.0.0.1:8222"', '')
      .replace('"/data/jetstream"', JSON.stringify(join(dir, 'js')));
    writeFileSync(join(dir, 'nats.conf'), conf);
    server = spawn(NATS_BIN, ['-c', join(dir, 'nats.conf'), '-a', '127.0.0.1'], {
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const nc = await tryConnect(k.hub.seed);
      if (typeof nc !== 'string') {
        open.push(nc);
        break;
      }
      if (Date.now() > deadline) throw new Error(`nats-server did not start: ${nc}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 30_000);

  afterAll(async () => {
    for (const nc of open) await nc.close().catch(() => undefined);
    server?.kill();
  });

  it('confines the bridge: no auth requests, no other participant RPCs', async () => {
    const bridge = await connected(k.bridge.seed);
    const errors: string[] = [];
    void (async () => {
      for await (const s of bridge.status()) if (s.type === 'error') errors.push(String(s.error));
    })();
    const hub = open[0] as NatsConnection;
    const leaked: string[] = [];
    hub.subscribe(`${PREFIX}.rpc.alice-agent.>`, {
      callback: (_e, m) => {
        leaked.push(m.subject);
      },
    });
    await hub.flush();

    bridge.subscribe('$SYS.REQ.USER.AUTH');
    bridge.publish(`${PREFIX}.rpc.alice-agent.peers.list`);
    await bridge.flush().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));

    // Do not match the server's wording beyond "permission".
    expect(errors.filter((e) => /permission/i.test(e)).length).toBeGreaterThanOrEqual(2);
    expect(errors.join(' ')).toContain('$SYS.REQ.USER.AUTH');
    expect(leaked).toEqual([]);
  });

  it('lets the hub use JetStream in the app account', async () => {
    const hub = open[0] as NatsConnection;
    const info = await hub.request('$JS.API.INFO', '', { timeout: 3000 });
    expect(JSON.parse(new TextDecoder().decode(info.data)).type).toBe(
      'io.nats.jetstream.api.v1.account_info_response',
    );
  });

  it('refuses agents while no callout service answers, even with a configured key', async () => {
    expect(typeof (await tryConnect(k.agent.seed))).toBe('string');
    expect(typeof (await tryConnect(createUser().getSeed()))).toBe('string');
  }, 30_000);

  it('limits the system user to kicking connections', async () => {
    const sys = await connected(k.sys.seed);
    const connz = await sys
      .request('$SYS.REQ.SERVER.PING.CONNZ', '', { timeout: 1000 })
      .then(() => 'answered')
      .catch(() => 'refused');
    expect(connz).toBe('refused');
  });
});
