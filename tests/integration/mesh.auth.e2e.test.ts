import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBus, RpcClient } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import { inboxPrefix } from '@agentmesh/protocol';
import { createUser } from '@nats-io/nkeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderNatsConfig } from '../../apps/cli/src/render/nats-config';
import { natsUsersFromConfig } from '../../apps/cli/src/render/permissions';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';
import { type Agent, PLUGIN, spawnAgent, untilConnected } from './support';

/**
 * The production security model, for real: nats-server runs the config that
 * `agentmesh nats-config` renders, every process authenticates with its own
 * nkey, and each agent may only act as itself.
 * Needs AGENTMESH_TEST_NATS_BIN=<path to nats-server> and a built plugin.
 */
const NATS_BIN = process.env.AGENTMESH_TEST_NATS_BIN ?? '';
const PORT = 4400 + Math.floor(Date.now() % 500);
const URL = `nats://127.0.0.1:${PORT}`;
const PREFIX = 'authe2e';
const IDS = ['hub', 'alice-agent', 'bob-agent', 'carol-agent', 'discord-bridge', 'hermes'] as const;

function keys() {
  const out = {} as Record<(typeof IDS)[number], { seed: string; pub: string }>;
  for (const id of IDS) {
    const user = createUser();
    out[id] = { seed: new TextDecoder().decode(user.getSeed()), pub: user.getPublicKey() };
  }
  return out;
}

describe.skipIf(!NATS_BIN || !existsSync(NATS_BIN) || !existsSync(PLUGIN))(
  'authenticated mesh',
  () => {
    const k = keys();
    const loaded = testTeamConfig({
      mesh: { name: 'auth-e2e', prefix: PREFIX },
      hub: { nkey: k.hub.pub, http: { enabled: false }, tickSeconds: 1 },
      agents: [
        { id: 'alice-agent', owner: 'alice', skills: ['backend'], nkey: k['alice-agent'].pub },
        { id: 'bob-agent', owner: 'bob', skills: ['frontend'], nkey: k['bob-agent'].pub },
        { id: 'carol-agent', owner: 'carol', skills: ['backend'], nkey: k['carol-agent'].pub },
      ],
      services: [
        {
          id: 'discord-bridge',
          role: 'bridge',
          canActAsHumans: true,
          nkey: k['discord-bridge'].pub,
        },
        { id: 'hermes', role: 'ingest', nkey: k.hermes.pub },
      ],
    });
    let server: ChildProcess;
    let hub: Hub;
    const agents: Agent[] = [];

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentmesh-auth-'));
      const conf = renderNatsConfig({
        meshName: 'auth-e2e',
        prefix: PREFIX,
        users: natsUsersFromConfig(loaded.config),
        dev: false,
        maxFileStore: '256MB',
        allowMissing: false,
      })
        .text.replace('port: 4222', `port: ${PORT}`)
        .replace('http: "127.0.0.1:8222"', '')
        .replace('"/data/jetstream"', JSON.stringify(join(dir, 'js')));
      writeFileSync(join(dir, 'nats.conf'), conf);
      server = spawn(NATS_BIN, ['-c', join(dir, 'nats.conf'), '-a', '127.0.0.1'], {
        stdio: 'ignore',
      });
      hub = await createHub({
        loaded,
        dataDir: ':memory:',
        nats: { servers: [URL], credentials: { nkeySeed: k.hub.seed } },
        logger: createLogger('auth-hub', { level: 'warn', destination: 'stderr' }),
      });
      await hub.start();
    }, 30_000);

    afterAll(async () => {
      for (const a of agents) await a.client.close().catch(() => undefined);
      await hub?.stop();
      server?.kill();
    });

    it('delivers between agents that each hold only their own permissions', async () => {
      const start = (id: 'alice-agent' | 'bob-agent') =>
        spawnAgent({ agentId: id, natsUrl: URL, prefix: PREFIX, nkeySeed: k[id].seed });
      const [alice, bob] = await Promise.all([start('alice-agent'), start('bob-agent')]);
      agents.push(alice, bob);
      await untilConnected(() => alice.call('peers', {}));
      const sent = await alice.call('ask', { to: 'bob-agent', text: 'auth ping' });
      const threadId = /thr-\d+/.exec(sent)?.[0] ?? '';
      expect((await bob.waitFor((e) => e.meta.thread_id === threadId)).content).toBe('auth ping');
      await bob.call('reply', { thread_id: threadId, text: 'auth pong' });
      expect((await alice.waitFor((e) => e.content === 'auth pong')).meta.from).toBe('bob-agent');
    }, 60_000);

    it('refuses to let one agent call the hub as another', async () => {
      const logger = createLogger('mallory', { level: 'silent', destination: 'stderr' });
      const nc = await connectBus({
        servers: [URL],
        name: 'impersonation-test',
        inboxPrefix: inboxPrefix('alice-agent'),
        credentials: { nkeySeed: k['alice-agent'].seed },
        logger,
      });
      try {
        const asBob = new RpcClient(nc, PREFIX, 'bob-agent', 3000);
        await expect(asBob.call('peers.list', {})).rejects.toThrow();
        const asAlice = new RpcClient(nc, PREFIX, 'alice-agent', 3000);
        expect((await asAlice.call('peers.list', {})).peers.length).toBeGreaterThan(0);
      } finally {
        await nc.close();
      }
    }, 30_000);
  },
);
