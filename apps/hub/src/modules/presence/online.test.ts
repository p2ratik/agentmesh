import { describe, expect, it } from 'vitest';
import { buildModules } from '../../runtime/modules';
import { createTestHarness } from '../../testing/harness';
import { agent, baseTask as base, human } from '../../testing/tasks';

/** The real modules, wired as the hub wires them. */
function setup() {
  const h = createTestHarness();
  const { presence, sessions, tasks } = buildModules(h.ctx, null, { kick: null }).services;
  /** A heartbeating agent with one open session, activated or not. */
  const connect = (agentId: string, active: boolean) => {
    presence.touch(agentId);
    const id = sessions.open(agentId, { clientVersion: '0.3.0' }).session.id;
    if (active) sessions.activate(agentId, id, 'working');
    return id;
  };
  const reviewRequest = async (id: string) => {
    await h.outbox.flush();
    return h.ports.deliveries.find(
      (d) => d.recipientId === id && d.message.refs.action === 'review_requested',
    )?.message;
  };
  /** A task in `api` assigned to bob-agent and submitted for review. */
  const submitted = () => {
    tasks.create({ ...base, area: 'api', assignee: 'bob-agent' }, human('bob'));
    tasks.act(1, 'accept', {}, agent('bob-agent'));
    return tasks.act(
      1,
      'submit',
      { prUrl: 'https://github.com/acme/api/pull/7' },
      agent('bob-agent'),
    );
  };
  return { ...h, presence, sessions, tasks, connect, reviewRequest, submitted };
}

describe('online', () => {
  it('needs an active, live session for an agent, not just heartbeats', () => {
    const { presence, sessions, connect } = setup();
    const id = connect('alice-agent', false);
    expect(presence.isOnline('alice-agent')).toBe(false);
    sessions.activate('alice-agent', id, 'working');
    expect(presence.isOnline('alice-agent')).toBe(true);
  });

  it('keeps humans on heartbeats alone', () => {
    const { presence } = setup();
    presence.touch('alice');
    expect(presence.isOnline('alice')).toBe(true);
  });

  it('assigns to the owner with an active session over one with only an inactive session', () => {
    const { tasks, connect } = setup();
    connect('alice-agent', false);
    connect('carol-agent', true);
    expect(tasks.create({ ...base, area: 'api' }, human('bob')).assignee).toBe('carol-agent');
  });

  it('picks the reviewer with an active session over one with only an inactive session', () => {
    const { ctx, connect, submitted } = setup();
    ctx.index.config.review.maxReviewers = 1;
    connect('alice-agent', false);
    connect('carol-agent', true);
    expect(submitted().reviewers).toEqual(['carol-agent']);
  });

  it('says so in the review request when the picked reviewer has no active session', async () => {
    const { ctx, connect, submitted, reviewRequest } = setup();
    ctx.index.config.review.maxReviewers = 1;
    connect('alice-agent', false);
    expect(submitted().reviewers).toEqual(['alice-agent']);
    expect((await reviewRequest('alice-agent'))?.body).toContain('has no active session');
  });

  it('leaves the review request alone when the reviewer has an active session', async () => {
    const { ctx, connect, submitted, reviewRequest } = setup();
    ctx.index.config.review.maxReviewers = 1;
    connect('carol-agent', true);
    expect(submitted().reviewers).toEqual(['carol-agent']);
    const request = await reviewRequest('carol-agent');
    expect(request?.body).toContain('Review requested');
    expect(request?.body).not.toContain('has no active session');
  });
});
