import { existsSync } from 'node:fs';
import { connectBus, RpcClient } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import { inboxPrefix } from '@agentmesh/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';
import { type Agent, activate, PLUGIN, spawnAgent, untilConnected } from './support';

/**
 * Per-session delivery for real (spec §3): NATS (no auth), the hub and the
 * bundled plugin over MCP stdio, several plugin processes per agent.
 * Needs AGENTMESH_TEST_NATS=nats://… with JetStream, and a built plugin.
 */
const NATS = process.env.AGENTMESH_TEST_NATS ?? '';
const PREFIX = `ses${Date.now().toString(36)}`;
const QUIET_MS = 3000;

const threadOf = (sent: string) => /thr-\d+/.exec(sent)?.[0] ?? '';
const onThread = (agent: Agent, threadId: string) =>
  agent.events.filter((e) => e.meta.thread_id === threadId);
const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));

describe.skipIf(!NATS || !existsSync(PLUGIN))('per-session delivery end to end', () => {
  let hub: Hub;
  let agents: Agent[] = [];

  /** A plugin process with a hub session (inactive until `activate`). */
  const spawn = async (agentId: string) => {
    const agent = await spawnAgent({ agentId, natsUrl: NATS, prefix: PREFIX });
    agents.push(agent);
    // Needs the hub session, so it succeeds only once hello is done; it does not activate.
    await untilConnected(() => agent.call('describe_session', { description: 'idle window' }));
    return agent;
  };

  beforeAll(async () => {
    hub = await createHub({
      loaded: testTeamConfig({
        mesh: { name: 'sessions-e2e', prefix: PREFIX },
        hub: { http: { enabled: false }, tickSeconds: 1 },
      }),
      dataDir: ':memory:',
      nats: { servers: [NATS] },
      logger: createLogger('sessions-hub', { level: 'warn', destination: 'stderr' }),
    });
    await hub.start();
  }, 30_000);

  // Closing a plugin says bye, which closes its session: each test starts from no sessions.
  afterEach(async () => {
    await Promise.all(agents.map((a) => a.client.close().catch(() => undefined)));
    agents = [];
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it('an inactive session of the same agent never receives', async () => {
    const [alice, b1, b2] = await Promise.all([
      spawn('alice-agent'),
      spawn('bob-agent'),
      spawn('bob-agent'),
    ]);
    await activate(b2, 'web client');
    const threadId = threadOf(
      await alice.call('ask', { to: 'bob-agent', text: 'Does the client handle 409?' }),
    );
    const asked = await b2.waitFor((e) => e.meta.thread_id === threadId);
    expect(asked.content).toBe('Does the client handle 409?');
    await quiet();
    expect(b1.events).toEqual([]);
  }, 60_000);

  it('the answer comes back to the session that asked', async () => {
    const [a1, a2, bob] = await Promise.all([
      spawn('alice-agent'),
      spawn('alice-agent'),
      spawn('bob-agent'),
    ]);
    // a1 is the longest-active session, where a new conversation would go.
    await activate(a1, 'billing api');
    await activate(a2, 'status codes');
    await activate(bob, 'web client');
    const threadId = threadOf(await a2.call('ask', { to: 'bob-agent', text: 'Ready for 409?' }));
    await bob.waitFor((e) => e.meta.thread_id === threadId);
    await bob.call('reply', { thread_id: threadId, text: 'Yes.', status: 'answer' });
    const answer = await a2.waitFor((e) => e.meta.thread_id === threadId);
    expect(answer.content).toBe('Yes.');
    await quiet();
    expect(onThread(a1, threadId)).toEqual([]);
  }, 60_000);

  it('a message waits while no session is active and arrives on activation', async () => {
    const [alice, carol] = await Promise.all([spawn('alice-agent'), spawn('carol-agent')]);
    const threadId = threadOf(
      await alice.call('ask', { to: 'carol-agent', text: 'Can you review the queue PR?' }),
    );
    await quiet();
    expect(onThread(carol, threadId)).toEqual([]);
    await activate(carol, 'queue');
    const queued = await carol.waitFor((e) => e.meta.thread_id === threadId);
    expect(queued.meta.from).toBe('alice-agent');
  }, 60_000);

  it('pre-0.3.0 plugins are told to update', async () => {
    const nc = await connectBus({
      servers: [NATS],
      name: 'old-plugin',
      inboxPrefix: inboxPrefix('alice-agent'),
      logger: createLogger('old-plugin', { level: 'silent', destination: 'stderr' }),
    });
    try {
      const rpc = new RpcClient(nc, PREFIX, 'alice-agent', 5000);
      await expect(rpc.call('session.hello', { clientVersion: '0.2.0' })).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining('claude plugin update'),
      });
    } finally {
      await nc.close();
    }
  }, 30_000);
});
