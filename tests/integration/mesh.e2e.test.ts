import { existsSync } from 'node:fs';
import { createLogger } from '@agentmesh/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';
import { type Agent, PLUGIN, spawnAgent, untilConnected } from './support';

/**
 * Real NATS (no auth) + real hub + the bundled plugin over MCP stdio.
 * Needs AGENTMESH_TEST_NATS=nats://… with JetStream, and a built plugin.
 */
const NATS = process.env.AGENTMESH_TEST_NATS ?? '';
const PREFIX = `e2e${Date.now().toString(36)}`;

describe.skipIf(!NATS || !existsSync(PLUGIN))('mesh end to end over NATS', () => {
  let hub: Hub;
  const agents: Agent[] = [];
  const spawn = (agentId: string) => spawnAgent({ agentId, natsUrl: NATS, prefix: PREFIX });

  beforeAll(async () => {
    hub = await createHub({
      loaded: testTeamConfig({
        mesh: { name: 'e2e', prefix: PREFIX },
        hub: { http: { enabled: false }, tickSeconds: 1 },
      }),
      dataDir: ':memory:',
      nats: { servers: [NATS] },
      logger: createLogger('e2e-hub', { level: 'warn', destination: 'stderr' }),
    });
    await hub.start();
  }, 30_000);

  afterAll(async () => {
    for (const a of agents) await a.client.close().catch(() => undefined);
    await hub?.stop();
  });

  it('pushes an ask into the other session and the reply back', async () => {
    const [alice, bob] = await Promise.all([spawn('alice-agent'), spawn('bob-agent')]);
    agents.push(alice, bob);
    expect(await untilConnected(() => alice.call('peers', { kind: 'agent' }))).toMatch(
      /bob-agent .* online/,
    );
    const sent = await alice.call('ask', { to: 'bob-agent', text: 'Is the render API ready?' });
    const threadId = /thr-\d+/.exec(sent)?.[0] ?? '';
    const asked = await bob.waitFor((e) => e.meta.thread_id === threadId);
    expect(asked.content).toBe('Is the render API ready?');
    expect(asked.meta).toMatchObject({ from: 'alice-agent', from_kind: 'agent', kind: 'ask' });

    await bob.call('reply', { thread_id: threadId, text: 'Yes, ship it.', status: 'answer' });
    const answer = await alice.waitFor(
      (e) => e.meta.thread_id === threadId && e.meta.status === 'answer',
    );
    expect(answer.content).toBe('Yes, ship it.');
  }, 60_000);

  it('queues messages for an offline teammate and delivers them on connect', async () => {
    const [alice] = agents;
    if (!alice) throw new Error('first test must run');
    await alice.call('ask', { to: 'carol-agent', text: 'Can you review the queue PR when back?' });
    await new Promise((r) => setTimeout(r, 1500));
    const carol = await spawn('carol-agent');
    agents.push(carol);
    const queued = await carol.waitFor((e) => e.content.includes('review the queue PR'));
    expect(queued.meta.from).toBe('alice-agent');
  }, 60_000);

  it('routes a new task to the area owner with an assignment brief', async () => {
    const [alice, bob] = agents;
    if (!alice || !bob) throw new Error('first test must run');
    const created = await alice.call('task_create', { title: 'Add a status badge', area: 'web' });
    expect(created).toMatch(/task-\d+ \[assigned\] → bob-agent/);
    const brief = await bob.waitFor(
      (e) => e.meta.kind === 'task' && e.content.includes('assigned to you'),
    );
    expect(brief.content).toContain('suggested branch');
    const accepted = await bob.call('task_act', {
      task_id: brief.meta.task_id ?? '',
      action: 'accept',
    });
    expect(accepted).toContain('in_progress');
  }, 60_000);
});
