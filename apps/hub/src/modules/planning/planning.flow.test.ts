import { MINUTE_MS } from '@agentmesh/common';
import type { LoadedConfig } from '@agentmesh/config';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../../contracts';
import { testTeamConfig } from '../../testing/fixtures';
import { joinTeam, leaveTeam } from '../../testing/harness';
import { createServiceHarness } from '../../testing/services';
import { TaskServiceImpl } from '../tasks/tasks.service';
import { PlanningServiceImpl } from './planning.service';

const agent = (id: string): Actor => ({ id, kind: 'agent', roles: [] });
const alice: Actor = { id: 'alice', kind: 'human', roles: ['admin'] };
const AGENTS = ['alice-agent', 'bob-agent', 'carol-agent'];
/** Assembled at runtime so repository secret scanners never flag this file. */
const TOKEN = ['ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('');

function setup(loaded: LoadedConfig = testTeamConfig(), online = AGENTS) {
  const h = createServiceHarness(loaded, { online });
  const tasks = new TaskServiceImpl(h.ctx, {
    messaging: h.messaging,
    presence: h.presence,
    leases: h.leases,
  });
  h.presence.setLoadReader(() => tasks.activeLoad());
  const planning = new PlanningServiceImpl(h.ctx, {
    messaging: h.messaging,
    tasks,
    presence: h.presence,
  });
  return { ...h, tasks, planning };
}

const drafts = [
  { key: 'api', title: 'Add status field to render API', description: 'enum', area: 'api' },
  {
    key: 'ui',
    title: 'Show render status in web',
    description: '',
    area: 'web',
    dependsOn: ['api'],
  },
];

/** Every agent contributes to both rounds of the standard template. */
function runRounds(s: ReturnType<typeof setup>) {
  for (const id of AGENTS) s.planning.contribute(1, `proposal from ${id}`, agent(id));
  for (const id of AGENTS) s.planning.contribute(1, `discussion from ${id}`, agent(id));
}

describe('planning sessions', () => {
  it('invites every agent, facilitated by the initiator human’s agent', async () => {
    const s = setup();
    const plan = s.planning.start({ topic: 'Render status end to end' }, alice);
    expect(plan.facilitator).toBe('alice-agent');
    expect(plan.participants).toEqual(AGENTS);
    expect(plan.currentRound).toBe('proposals');
    const inbox = await s.drain();
    for (const id of AGENTS) expect(inbox.get(id)?.[0]?.body).toContain('Round 1/2 — Proposals');
    expect(s.ports.events.map((e) => e.type)).toContain('plan.started');
  });

  it('starting a plan as an agent sends it no invite; a human starter still invites every agent', async () => {
    const byAgent = setup();
    byAgent.planning.start({ topic: 'Render status end to end' }, agent('alice-agent'));
    const inbox = await byAgent.drain();
    expect(inbox.get('alice-agent')).toBeUndefined();
    for (const id of ['bob-agent', 'carol-agent']) expect(inbox.get(id)).toHaveLength(1);
    const byHuman = setup();
    byHuman.planning.start({ topic: 'Render status end to end' }, alice);
    expect((await byHuman.drain()).get('alice-agent')).toHaveLength(1);
  });

  it('a round prompt reaches every participant as action, including the one whose contribution opened it', async () => {
    const s = setup();
    s.planning.start({ topic: 'Render status end to end' }, alice);
    await s.drain();
    for (const id of AGENTS) s.planning.contribute(1, `proposal from ${id}`, agent(id));
    const inbox = await s.drain();
    // carol-agent's contribution completed round 1.
    for (const id of AGENTS) {
      const round = inbox.get(id)?.find((m) => m.body.includes('Round 2/2'));
      expect(round?.class, id).toBe('action');
    }
  });

  it('materialized tasks notify participants as status', async () => {
    const s = setup();
    s.planning.start({ topic: 'Render status end to end' }, alice);
    runRounds(s);
    await s.drain();
    s.planning.submit(1, 'Agreed: enum status.', drafts, agent('alice-agent'));
    const inbox = await s.drain();
    expect(inbox.get('alice-agent')?.find((m) => m.body.includes('is final'))).toBeUndefined();
    for (const id of ['bob-agent', 'carol-agent']) {
      expect(inbox.get(id)?.find((m) => m.body.includes('is final'))?.class, id).toBe('status');
    }
  });

  it('keeps contributions out of inboxes and moves on at quorum with a digest', async () => {
    const s = setup();
    s.planning.start({ topic: 'Render status end to end' }, alice);
    await s.drain();
    expect(s.planning.contribute(1, 'api first', agent('alice-agent')).roundComplete).toBe(false);
    expect((await s.drain()).size).toBe(0);
    s.planning.contribute(1, 'web after', agent('bob-agent'));
    expect(s.planning.contribute(1, 'agree', agent('carol-agent'))).toEqual({
      round: 'proposals',
      roundComplete: true,
    });
    const digest = (await s.drain()).get('bob-agent')?.[0]?.body ?? '';
    expect(digest).toContain('Round 2/2 — Discussion');
    expect(digest).toContain('api first');
    expect(s.planning.get(1).currentRound).toBe('discussion');
  });

  it('stores contributions redacted, so plan_get and the digest cut never show a token', async () => {
    const s = setup();
    s.planning.start({ topic: 'Render status end to end' }, alice);
    await s.drain();
    // Three contributions over 12,000 characters get 4,000 each: the digest cut lands 20
    // characters into the raw token, too few for it to match afterwards.
    const long = `${'a'.repeat(3_979)} ${TOKEN} ${'b'.repeat(9_000)}`;
    s.planning.contribute(1, long, agent('alice-agent'));
    s.planning.contribute(1, 'web after', agent('bob-agent'));
    s.planning.contribute(1, 'agree', agent('carol-agent'));
    expect(s.planning.contributions(1)[0]?.body).not.toContain('ghp_');
    const digest = (await s.drain()).get('bob-agent')?.[0]?.body ?? '';
    expect(digest).toContain('truncated');
    expect(digest).toContain('[REDACTED]');
    expect(digest).not.toContain('ghp_');
  });

  it('advances on the deadline and asks only the facilitator to synthesize', async () => {
    const s = setup(testTeamConfig(), []);
    s.planning.start({ topic: 'Render status', roundMinutes: 10 }, alice);
    s.clock.advance(11 * MINUTE_MS);
    s.planning.tick(s.clock.now());
    expect(s.planning.get(1).currentRound).toBe('discussion');
    s.clock.advance(11 * MINUTE_MS);
    s.planning.tick(s.clock.now());
    expect(s.planning.get(1).state).toBe('synthesizing');
    const inbox = await s.drain();
    expect(inbox.get('alice-agent')?.at(-1)?.body).toContain('you are the facilitator');
    expect(inbox.get('bob-agent')?.at(-1)?.body).toContain('is synthesizing');
  });

  it('turns a valid synthesis into ordered, routed tasks', async () => {
    const s = setup();
    s.planning.start({ topic: 'Render status end to end' }, alice);
    runRounds(s);
    expect(() =>
      s.planning.submit(
        1,
        'x',
        [{ key: 'a', title: 'Cyclic', description: '', dependsOn: ['a'] }],
        agent('alice-agent'),
      ),
    ).toThrow(/depends on itself/);
    expect(() => s.planning.submit(1, 'x', drafts, agent('bob-agent'))).toThrow(/facilitator/);

    const plan = s.planning.submit(1, 'Agreed: enum status.', drafts, agent('alice-agent'));
    expect(plan.state).toBe('materialized');
    expect(plan.taskIds).toEqual(['task-1', 'task-2']);
    const api = s.tasks.get(1, alice);
    const ui = s.tasks.get(2, alice);
    expect(api.planId).toBe('plan-1');
    expect(['alice-agent', 'carol-agent']).toContain(api.assignee);
    expect(ui.dependsOn).toEqual(['task-1']);
    expect(ui.assignee).toBeNull();
    const summary = (await s.drain()).get('carol-agent')?.find((m) => m.body.includes('is final'));
    expect(summary?.body).toContain('task-2');
  });

  it('waits for a human when approval is required', () => {
    const s = setup(testTeamConfig({ planning: { requireApproval: true } }));
    s.planning.start({ topic: 'Render status' }, alice);
    runRounds(s);
    expect(s.planning.submit(1, 'ok', drafts, agent('alice-agent')).state).toBe(
      'awaiting_approval',
    );
    expect(s.planning.approve(1).state).toBe('materialized');
  });

  it('approves a plan whose facilitator and a draft assignee have left the team', () => {
    const s = setup(testTeamConfig({ planning: { requireApproval: true } }));
    s.planning.start({ topic: 'Render status', facilitator: 'carol-agent' }, alice);
    runRounds(s);
    const assigned = drafts.map((d) => (d.key === 'api' ? { ...d, assignee: 'carol-agent' } : d));
    s.planning.submit(1, 'ok', assigned, agent('carol-agent'));
    leaveTeam(s.ctx, 'carol');
    expect(s.planning.approve(1).state).toBe('materialized');
    expect(s.tasks.get(1, alice).assignee).not.toBe('carol-agent');
  });

  // mesh.yaml may name a facilitator who joins by invite; until they do, the initiator's agent stands in.
  it('lets the initiator facilitate until the configured facilitator has joined', () => {
    const s = setup(testTeamConfig({ planning: { facilitator: 'dana-agent' } }));
    expect(s.planning.start({ topic: 'Render status' }, alice).facilitator).toBe('alice-agent');
    joinTeam(s.ctx, 'dana');
    expect(s.planning.start({ topic: 'Billing v2' }, alice).facilitator).toBe('dana-agent');
  });

  it('hands off a late synthesis once, then stalls and escalates', async () => {
    const s = setup();
    s.planning.start({ topic: 'Render status', roundMinutes: 5 }, alice);
    s.planning.contribute(1, 'only me', agent('bob-agent'));
    for (let i = 0; i < 2; i += 1) {
      s.clock.advance(6 * MINUTE_MS);
      s.planning.tick(s.clock.now());
    }
    expect(s.planning.get(1).state).toBe('synthesizing');
    s.clock.advance(31 * MINUTE_MS);
    s.planning.tick(s.clock.now());
    expect(s.planning.get(1).facilitator).toBe('bob-agent');
    s.clock.advance(31 * MINUTE_MS);
    s.planning.tick(s.clock.now());
    expect(s.planning.get(1).state).toBe('stalled');
    await s.drain();
    const escalation = s.ports.events.find(
      (e) => e.type === 'message.created' && e.data.message.kind === 'escalation',
    );
    expect(escalation?.type === 'message.created' && escalation.data.message.to).toEqual(['alice']);
  });

  it('lets only the initiator, facilitator or a human cancel', () => {
    const s = setup();
    s.planning.start({ topic: 'Render status' }, agent('bob-agent'));
    expect(() => s.planning.cancel(1, null, agent('carol-agent'))).toThrow(/Only the initiator/);
    expect(s.planning.cancel(1, 'dup', agent('bob-agent')).state).toBe('cancelled');
    expect(() => s.planning.contribute(1, 'late', agent('bob-agent'))).toThrow(/cancelled/);
  });
});
