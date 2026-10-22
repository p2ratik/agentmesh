import { existsSync } from 'node:fs';
import { createLogger } from '@agentmesh/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';
import { type Agent, activate, PLUGIN, spawnAgent } from './support';

/**
 * What interrupts an agent, for real (spec §4 Part B): NATS (no auth), the hub
 * and the bundled plugin over MCP stdio. Action items are pushed; status items
 * ride along on the next tool result or push; nobody hears an echo of its own call.
 * Needs AGENTMESH_TEST_NATS=nats://… with JetStream, and a built plugin.
 */
const NATS = process.env.AGENTMESH_TEST_NATS ?? '';
const PREFIX = `int${Date.now().toString(36)}`;
const QUIET_MS = 3000;

const threadOf = (sent: string) => /thr-\d+/.exec(sent)?.[0] ?? '';
const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));
/** Returns the channel events the agent gets from now on. */
const newEvents = (agent: Agent) => {
  const from = agent.events.length;
  return () => agent.events.slice(from);
};

describe.skipIf(!NATS || !existsSync(PLUGIN))('what interrupts an agent, end to end', () => {
  let hub: Hub;
  let alice: Agent;
  let bob: Agent;
  let carol: Agent;
  const spawn = (agentId: string) => spawnAgent({ agentId, natsUrl: NATS, prefix: PREFIX });

  beforeAll(async () => {
    hub = await createHub({
      loaded: testTeamConfig({
        mesh: { name: 'interrupts-e2e', prefix: PREFIX },
        hub: { http: { enabled: false }, tickSeconds: 1 },
      }),
      dataDir: ':memory:',
      nats: { servers: [NATS] },
      logger: createLogger('interrupts-hub', { level: 'warn', destination: 'stderr' }),
    });
    await hub.start();
    [alice, bob, carol] = await Promise.all([
      spawn('alice-agent'),
      spawn('bob-agent'),
      spawn('carol-agent'),
    ]);
    await Promise.all([
      activate(alice, 'billing api'),
      activate(bob, 'web client'),
      activate(carol, 'metrics'),
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([alice, bob, carol].map((a) => a?.client.close().catch(() => undefined)));
    await hub?.stop();
  });

  it('a working reply interrupts nobody and rides along on the next tool result', async () => {
    const threadId = threadOf(await alice.call('ask', { to: 'bob-agent', text: 'Badge done?' }));
    await bob.waitFor((e) => e.meta.thread_id === threadId);
    const aliceGot = newEvents(alice);
    await bob.call('reply', { thread_id: threadId, text: 'Working on it.', status: 'working' });
    await quiet();
    expect(aliceGot()).toEqual([]);

    const peers = await alice.call('peers', { kind: 'agent' });
    expect(peers).toMatch(new RegExp(`\\nFYI \\(1\\):\\n· ${threadId} «[^»]*» Working on it\\.$`));
    expect(await alice.call('inbox', {})).not.toContain('Working on it.');
  }, 60_000);

  it('a question still interrupts', async () => {
    const threadId = threadOf(await bob.call('ask', { to: 'alice-agent', text: 'Red or green?' }));
    const asked = await alice.waitFor((e) => e.meta.thread_id === threadId);
    expect(asked).toMatchObject({
      content: 'Red or green?',
      meta: { from: 'bob-agent', kind: 'ask' },
    });

    // Only `working` and `info` replies are quiet: a follow-up question after one still pushes.
    await alice.call('reply', { thread_id: threadId, text: 'Checking.', status: 'working' });
    await bob.call('reply', { thread_id: threadId, text: 'And dark mode?' });
    const followUp = await alice.waitFor(
      (e) => e.meta.thread_id === threadId && e.content.includes('And dark mode?'),
    );
    expect(followUp.meta.from).toBe('bob-agent');
  }, 60_000);

  it('the reviewer gets no echo of its own approval', async () => {
    const requested = await bob.call('request_review', {
      pr_url: 'https://github.com/acme/web/pull/7',
      reviewers: ['alice-agent'],
    });
    const taskId = /task-\d+/.exec(requested)?.[0] ?? '';
    await alice.waitFor((e) => e.meta.task_id === taskId && e.content.includes('Review requested'));
    const aliceGot = newEvents(alice);
    const submitted = await alice.call('review_submit', {
      task_id: taskId,
      verdict: 'approve',
      body: 'LGTM.',
    });
    const verdict = await bob.waitFor(
      (e) => e.meta.task_id === taskId && e.content.includes('is approved'),
    );
    expect(verdict.content).toContain('LGTM.');
    await quiet();
    expect(aliceGot()).toEqual([]);
    // Not even as an FYI: "approved" is status for a reviewer, so an echo would ride along here.
    const results = [submitted, await alice.call('peers', { kind: 'agent' })].join('\n');
    expect(results).not.toContain(`· ${verdict.meta.thread_id} `);
  }, 60_000);

  it("a plan's tasks interrupt each assignee once per task", async () => {
    const started = await alice.call('plan_start', { topic: 'Status badges' });
    const planId = /plan-\d+/.exec(started)?.[0] ?? '';
    await Promise.all([bob, carol].map((a) => a.waitFor((e) => e.meta.plan_id === planId)));
    const [aliceGot, bobGot, carolGot] = [newEvents(alice), newEvents(bob), newEvents(carol)];

    const submitted = await alice.call('plan_submit', {
      plan_id: planId,
      summary: 'Two web tasks and one api task.',
      tasks: [
        { key: 'badge', title: 'Render the badge', area: 'web', assignee: 'bob-agent' },
        { key: 'tooltip', title: 'Badge tooltip', area: 'web', assignee: 'bob-agent' },
        { key: 'metrics', title: 'Badge metrics', area: 'api', assignee: 'carol-agent' },
      ],
    });
    // `m`: an FYI block may ride along after the "created …" line.
    const [badge, tooltip, metrics] = /created (.*)\.$/m.exec(submitted)?.[1]?.split(', ') ?? [];
    await bob.waitFor((e) => e.meta.task_id === badge);
    await bob.waitFor((e) => e.meta.task_id === tooltip);
    await carol.waitFor((e) => e.meta.task_id === metrics);
    await quiet();

    // One push per task each assignee owns, each its assignment; nothing else interrupts.
    const briefs = (got: typeof bobGot) =>
      got()
        .map((e) => [e.meta.task_id, e.content.includes('is assigned to you')])
        .sort();
    expect(briefs(bobGot)).toEqual(
      [
        [badge, true],
        [tooltip, true],
      ].sort(),
    );
    expect(briefs(carolGot)).toEqual([[metrics, true]]);
    expect(aliceGot()).toEqual([]);
    // The plan's result is status: it rode along on a push or rides on the next tool result.
    const rideAlong = [...bobGot().map((e) => e.content), await bob.call('peers', {})];
    expect(rideAlong.join('\n')).toMatch(
      new RegExp(`FYI \\(\\d+\\):[\\s\\S]*${planId}[^\\n]*is final`),
    );
  }, 60_000);
});
