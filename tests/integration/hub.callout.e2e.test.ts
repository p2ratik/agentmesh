import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBus, RpcClient } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import { inboxPrefix } from '@agentmesh/protocol';
import { createAccount, createCurve, createUser, type KeyPair } from '@nats-io/nkeys';
import { connect, type NatsConnection, nkeyAuthenticator } from '@nats-io/transport-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';
import { startCalloutNats } from './callout-server';

/**
 * The hub's auth callout against a real nats-server in account mode: agents
 * are admitted only by the hub (task-9). Needs AGENTMESH_TEST_NATS_BIN.
 */
const NATS_BIN = process.env.AGENTMESH_TEST_NATS_BIN ?? '';
const PORT = 5500 + Math.floor(Date.now() % 400);
const URL = `nats://127.0.0.1:${PORT}`;
const PREFIX = 'hubcallout';
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const seedOf = (kp: KeyPair) => new TextDecoder().decode(kp.getSeed());

/** Connects as an agent the way the plugin does: nkey signature, plus an invite on first join. */
async function asAgent(
  key: KeyPair,
  agentId: string,
  opts: { token?: string; signer?: KeyPair } = {},
): Promise<NatsConnection | string> {
  try {
    return await connect({
      servers: URL,
      reconnect: false,
      timeout: 4000,
      inboxPrefix: inboxPrefix(agentId),
      authenticator: (nonce?: string) => ({
        nkey: key.getPublicKey(),
        sig: b64((opts.signer ?? key).sign(new TextEncoder().encode(nonce ?? ''))),
        ...(opts.token ? { auth_token: opts.token } : {}),
      }),
    });
  } catch (error) {
    return String(error);
  }
}

describe.skipIf(!NATS_BIN || !existsSync(NATS_BIN))('hub auth callout', () => {
  const k = {
    hub: createUser(),
    bridge: createUser(),
    alice: createUser(),
    issuer: createAccount(),
    xkey: createCurve(),
    sys: createUser(),
  };
  const loaded = testTeamConfig({
    mesh: { name: 'hub-callout', prefix: PREFIX },
    hub: {
      nkey: k.hub.getPublicKey(),
      http: { enabled: false },
      tickSeconds: 1,
      authCallout: {
        issuer: k.issuer.getPublicKey(),
        xkey: k.xkey.getPublicKey(),
        sysNkey: k.sys.getPublicKey(),
      },
    },
    agents: [
      { id: 'alice-agent', owner: 'alice', nkey: k.alice.getPublicKey() },
      { id: 'bob-agent', owner: 'bob' },
      { id: 'carol-agent', owner: 'carol' },
    ],
    services: [
      { id: 'discord-bridge', role: 'bridge', canActAsHumans: true, nkey: k.bridge.getPublicKey() },
    ],
    enrollment: { natsUrl: URL },
  });
  let server: ChildProcess;
  let hub: Hub;
  const open: NatsConnection[] = [];
  const connected = (nc: NatsConnection | string): NatsConnection => {
    if (typeof nc === 'string') throw new Error(`expected a connection, got: ${nc}`);
    open.push(nc);
    return nc;
  };
  const invite = async (humanId: string, discordUserId: string) =>
    (
      (await hub.dispatch(
        { caller: 'discord-bridge', method: 'enrollment.invite', actAs: 'alice' },
        { humanId, displayName: humanId, discordUserId },
      )) as { code: string }
    ).code;

  let dir = '';
  let hubUp = false;
  const startServer = () => startCalloutNats({ bin: NATS_BIN, loaded, dir, port: PORT });
  const startHub = async () => {
    hub = await createHub({
      loaded,
      dataDir: ':memory:',
      nats: { servers: [URL], credentials: { nkeySeed: seedOf(k.hub) } },
      callout: { issuer: k.issuer, xkey: k.xkey, sysSeed: seedOf(k.sys) },
      logger: createLogger('callout-hub', { level: 'silent', destination: 'stderr' }),
    });
    await hub.start();
    hubUp = true;
  };
  const stopHub = async () => {
    if (!hubUp) return;
    hubUp = false;
    await hub.stop();
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentmesh-hub-callout-'));
    server = startServer();
    await startHub();
  }, 30_000);

  afterAll(async () => {
    for (const nc of open) await nc.close().catch(() => undefined);
    await stopHub().catch(() => undefined);
    server?.kill();
  });

  it('admits a mesh.yaml agent by its key, scoped to its own RPC subject', async () => {
    const nc = connected(await asAgent(k.alice, 'alice-agent'));
    const asAlice = new RpcClient(nc, PREFIX, 'alice-agent', 4000);
    expect((await asAlice.call('peers.list', {})).peers.length).toBeGreaterThan(0);
    await expect(
      new RpcClient(nc, PREFIX, 'bob-agent', 2000).call('peers.list', {}),
    ).rejects.toThrow();
  }, 30_000);

  it('refuses a forged signature for a known key', async () => {
    expect(typeof (await asAgent(k.alice, 'alice-agent', { signer: createUser() }))).toBe('string');
  }, 30_000);

  it('lets a valid invite connect once, then refuses its reuse', async () => {
    const code = await invite('dana', '200000000000000001');
    const dana = createUser();
    const first = connected(await asAgent(dana, 'dana-agent', { token: code }));
    const hello = await new RpcClient(first, PREFIX, 'dana-agent', 4000).call('session.hello', {
      clientVersion: 'e2e',
    });
    expect(hello.self.id).toBe('dana-agent');
    expect(typeof (await asAgent(createUser(), 'dana-agent', { token: code }))).toBe('string');
    // Now a known key: reconnects need no invite.
    connected(await asAgent(dana, 'dana-agent'));
  }, 30_000);

  it('kicks a removed member and refuses their reconnect', async () => {
    const code = await invite('erin', '200000000000000002');
    const erin = createUser();
    const nc = connected(await asAgent(erin, 'erin-agent', { token: code }));
    const closed = nc.closed();
    await hub.dispatch(
      { caller: 'discord-bridge', method: 'enrollment.remove', actAs: 'alice' },
      { humanId: 'erin' },
    );
    const kicked = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    expect(kicked).toBe(true);
    expect(typeof (await asAgent(erin, 'erin-agent'))).toBe('string');
  }, 30_000);

  it('keeps static users connecting while the callout is down, and refuses agents', async () => {
    await stopHub();
    const bridge = await connect({
      servers: URL,
      reconnect: false,
      authenticator: nkeyAuthenticator(k.bridge.getSeed()),
    });
    open.push(bridge);
    expect(bridge.isClosed()).toBe(false);
    expect(typeof (await asAgent(k.alice, 'alice-agent'))).toBe('string');
  }, 30_000);

  // NATS and the hub restarting together (a deploy, a reboot): until the hub is back, the callout
  // refuses every reconnect. A long-lived agent connection must outlast that, not give up.
  it('reconnects an agent once the callout is back after NATS and the hub restart', async () => {
    await stopHub();
    await startHub();
    const nc = await connectBus({
      servers: [URL],
      name: 'agentmesh-plugin:alice-agent',
      inboxPrefix: inboxPrefix('alice-agent'),
      credentials: { nkeySeed: seedOf(k.alice) },
    });
    open.push(nc);
    // Disconnects: the restart itself, then one per refused reconnect. nats.js used to close the
    // connection at the second refusal; later refusals emit no `error` status, so count these.
    let disconnects = 0;
    const secondRefusal = (async () => {
      for await (const s of nc.status()) if (s.type === 'disconnect' && ++disconnects === 3) return;
    })();
    await stopHub();
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
    server = startServer();
    await Promise.race([secondRefusal, nc.closed()]);
    await startHub();
    // A refused dial can hang until nats.js's 20 s connect timeout, so allow for one of those.
    const asAlice = new RpcClient(nc, PREFIX, 'alice-agent', 2000);
    let peers = 0;
    for (let i = 0; i < 15 && !nc.isClosed() && peers === 0; i++) {
      peers = await asAlice.call('peers.list', {}).then(
        (r) => r.peers.length,
        () => new Promise<number>((r) => setTimeout(() => r(0), 1000)),
      );
    }
    expect(nc.isClosed()).toBe(false);
    expect(peers).toBeGreaterThan(0);
  }, 90_000);
});
