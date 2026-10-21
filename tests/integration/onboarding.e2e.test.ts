import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcClient } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import { decodeInvite, inboxPrefix } from '@agentmesh/protocol';
import { createAccount, createCurve, createUser, fromSeed, type KeyPair } from '@nats-io/nkeys';
import { connect, type NatsConnection, nkeyAuthenticator } from '@nats-io/transport-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteParams } from '../../apps/discord-bridge/src/commands/enrollment';
import { actAs } from '../../apps/discord-bridge/src/rpc';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';
import { startCalloutNats } from './callout-server';
import { type Agent, activate, PLUGIN, spawnAgent, untilConnected } from './support';

/**
 * The whole invite-only onboarding (task-11): an admin invites through the
 * bridge's RPC path, the bundled plugin joins with a key it generates, talks
 * to a mesh.yaml agent, is removed, kicked and refused. Real nats-server
 * 2.15.1 in account mode with the hub's auth callout; no Discord.
 * Needs AGENTMESH_TEST_NATS_BIN and a built plugin.
 */
const NATS_BIN = process.env.AGENTMESH_TEST_NATS_BIN ?? '';
const OFFSET = Math.floor(Date.now() % 400);
const PORT = 6000 + OFFSET;
const MONITOR = 6500 + OFFSET;
const URL = `nats://127.0.0.1:${PORT}`;
const HUB = `127.0.0.1:${PORT}`;
const PREFIX = 'onboard';
const seedOf = (kp: KeyPair) => new TextDecoder().decode(kp.getSeed());

/** Names of the clients nats-server has admitted right now. */
async function connectionNames(): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${MONITOR}/connz?limit=1024`);
  const body = (await res.json()) as { connections?: Array<{ name?: string }> };
  return (body.connections ?? []).map((c) => c.name ?? '');
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe.skipIf(!NATS_BIN || !existsSync(NATS_BIN) || !existsSync(PLUGIN))(
  'invite-only onboarding end to end',
  () => {
    const k = {
      hub: createUser(),
      bridge: createUser(),
      alice: createUser(),
      issuer: createAccount(),
      xkey: createCurve(),
      sys: createUser(),
    };
    const loaded = testTeamConfig({
      mesh: { name: 'onboarding', prefix: PREFIX },
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
        {
          id: 'discord-bridge',
          role: 'bridge',
          canActAsHumans: true,
          nkey: k.bridge.getPublicKey(),
        },
      ],
      enrollment: { natsUrl: URL },
    });
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-onboarding-'));
    const home = join(dir, 'home');
    const inviteFile = join(home, '.agentmesh', 'invite.txt');
    const hubLog = join(dir, 'hub.log');
    const logger = createLogger('onboarding-hub', {
      level: 'trace',
      destination: { file: hubLog },
    });
    let server: ChildProcess;
    let hub: Hub;
    let bridge: NatsConnection;
    let joiner: Agent;
    let code = '';
    const agents: Agent[] = [];
    /** What the bridge does for one slash command: actAs the admin, keyed by the interaction. */
    const bridgeRpc = () => new RpcClient(bridge, PREFIX, 'discord-bridge', 5000);
    const asAdmin = (interactionId: string) => actAs(bridgeRpc(), 'alice', interactionId);
    // Claude Code stored plugin.json's old "mesh" default for prefix; the team's is PREFIX.
    // agent.json's prefix from the invite must win in the join session (task-13; later sessions
    // are covered by config.test.ts).
    const joinerEnv = { agentId: '', natsUrl: '', prefix: 'mesh', home };

    beforeAll(async () => {
      server = startCalloutNats({ bin: NATS_BIN, loaded, dir, port: PORT, monitorPort: MONITOR });
      hub = await createHub({
        loaded,
        dataDir: ':memory:',
        nats: { servers: [URL], credentials: { nkeySeed: seedOf(k.hub) } },
        callout: { issuer: k.issuer, xkey: k.xkey, sysSeed: seedOf(k.sys) },
        logger,
      });
      await hub.start();
      bridge = await connect({
        servers: URL,
        inboxPrefix: inboxPrefix('discord-bridge'),
        authenticator: nkeyAuthenticator(k.bridge.getSeed()),
      });
    }, 30_000);

    afterAll(async () => {
      for (const a of agents) await a.client.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      await hub?.stop().catch(() => undefined);
      server?.kill();
    });

    it('an admin invites a new member through the bridge path', async () => {
      const invite = await asAdmin('ix-invite')(
        'enrollment.invite',
        inviteParams({
          user: { id: '200000000000000009', globalName: 'Dana', username: 'dana' },
          id: 'dana',
          name: null,
          roles: null,
          skills: 'qa',
          agent: null,
        }),
      );
      expect(invite.agentId).toBe('dana-agent');
      expect(decodeInvite(invite.code)).toMatchObject({ natsUrl: URL, prefix: PREFIX });
      code = invite.code;
      // The member saves the code from the DM to a file; it never enters the chat.
      mkdirSync(join(home, '.agentmesh'), { recursive: true });
      writeFileSync(inviteFile, `${code}\n`);
    }, 30_000);

    it('joins with the bundled plugin and a key generated on the laptop', async () => {
      joiner = await spawnAgent(joinerEnv);
      agents.push(joiner);
      const before = await joiner.client.listTools();
      expect(before.tools.map((t) => t.name)).toEqual(['join']);

      const first = await joiner.call('join', {});
      expect(first).toContain(`${HUB} as dana-agent`);
      expect(first).not.toContain(code.trim());
      expect(await connectionNames()).not.toContain('agentmesh-plugin:dana-agent');
      expect(joiner.notifications).not.toContain('notifications/tools/list_changed');

      const joined = await joiner.call('join', { confirm_hub: HUB });
      expect(joined).toContain('Joined the AgentMesh "onboarding" as dana-agent');
      expect(existsSync(inviteFile)).toBe(false);
      const saved = JSON.parse(readFileSync(join(home, '.agentmesh', 'agent.json'), 'utf8'));
      expect(saved).toMatchObject({ agentId: 'dana-agent', natsUrl: URL, prefix: PREFIX });
      const publicKey = fromSeed(
        new TextEncoder().encode(readFileSync(saved.nkeySeed, 'utf8').trim()),
      ).getPublicKey();
      // As the bridge itself, the way it refreshes its team index.
      const { members } = await bridgeRpc().call('enrollment.list', {});
      expect(members).toContainEqual(
        expect.objectContaining({ agentId: 'dana-agent', nkey: publicKey, status: 'active' }),
      );
      // Claude Code only re-reads the tool list when told it changed.
      const listChanged = async () =>
        joiner.notifications.includes('notifications/tools/list_changed');
      expect(await until(listChanged, 5000)).toBe(true);
      const after = await joiner.client.listTools();
      expect(after.tools.map((t) => t.name)).toContain('ask');
    }, 60_000);

    it('asks a mesh.yaml agent and gets the reply', async () => {
      const alice = await spawnAgent({
        agentId: 'alice-agent',
        natsUrl: URL,
        prefix: PREFIX,
        nkeySeed: seedOf(k.alice),
      });
      agents.push(alice);
      await untilConnected(() => alice.call('peers', { kind: 'agent' }));
      await Promise.all([activate(alice, 'web client'), activate(joiner, 'qa')]);
      const sent = await untilConnected(() =>
        joiner.call('ask', { to: 'alice-agent', text: 'Does the web client handle a 409?' }),
      );
      const threadId = /thr-\d+/.exec(sent)?.[0] ?? '';
      const asked = await alice.waitFor((e) => e.meta.thread_id === threadId);
      expect(asked.meta).toMatchObject({ from: 'dana-agent', from_kind: 'agent', kind: 'ask' });

      await alice.call('reply', {
        thread_id: threadId,
        text: 'Yes, it retries.',
        status: 'answer',
      });
      const answer = await joiner.waitFor(
        (e) => e.meta.thread_id === threadId && e.meta.status === 'answer',
      );
      expect(answer.content).toBe('Yes, it retries.');
    }, 60_000);

    it('removing the member kicks the live session and refuses the key', async () => {
      expect(await connectionNames()).toContain('agentmesh-plugin:dana-agent');
      const removed = await asAdmin('ix-remove')('enrollment.remove', { humanId: 'dana' });
      expect(removed).toMatchObject({ removed: true, agentIds: ['dana-agent'] });

      const gone = async () => !(await connectionNames()).includes('agentmesh-plugin:dana-agent');
      expect(await until(gone)).toBe(true);
      // The kicked plugin tries to reconnect (whether it then gives up after repeated
      // authorization errors or keeps retrying). No attempt may get in, so look again later.
      await new Promise((r) => setTimeout(r, 4500));
      expect(await gone()).toBe(true);

      const saved = JSON.parse(readFileSync(join(home, '.agentmesh', 'agent.json'), 'utf8'));
      const seed = readFileSync(saved.nkeySeed, 'utf8').trim();
      const raw = await connect({
        servers: URL,
        reconnect: false,
        timeout: 4000,
        inboxPrefix: inboxPrefix('dana-agent'),
        authenticator: nkeyAuthenticator(new TextEncoder().encode(seed)),
      }).then(
        (nc) => nc.close().then(() => 'admitted'),
        // A callout refusal shows up as an authorization error or as a reset.
        (error: unknown) => String(error),
      );
      expect(raw).toMatch(/authorization|ECONNRESET/i);

      // A fresh session from the same laptop setup never gets a connection.
      const again = await spawnAgent(joinerEnv);
      agents.push(again);
      await new Promise((r) => setTimeout(r, 3000));
      await expect(again.call('peers', {})).rejects.toThrow(/unreachable/i);
    }, 60_000);

    it('never writes the invite code to the hub log, the database or the plugin log', async () => {
      const secret = decodeInvite(code).secret;
      await new Promise<void>((r) => logger.flush(() => r()));
      const logText = readFileSync(hubLog, 'utf8');
      expect(logText).toContain('member joined');
      expect(logText).not.toContain(code.trim());
      expect(logText).not.toContain(secret);

      const db = hub.context.db;
      const idem = db.all<{ withheld: number }>(
        `SELECT withheld FROM rpc_idempotency WHERE caller = 'discord-bridge' AND key = 'ix-invite:enrollment.invite'`,
      );
      expect(idem).toEqual([{ withheld: 1 }]);
      const tables = db.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'`,
      );
      for (const { name } of tables) {
        const dump = JSON.stringify(db.all(`SELECT * FROM "${name}"`));
        expect(dump, name).not.toContain(code.trim());
        expect(dump, name).not.toContain(secret);
      }

      const pluginText = joiner.stderr();
      expect(pluginText).toContain('joined the mesh');
      expect(pluginText).not.toContain(code.trim());
      expect(pluginText).not.toContain(secret);
    }, 30_000);
  },
);
