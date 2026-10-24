import { describe, expect, it } from 'vitest';
import { joinTeam, leaveTeam } from '../../testing/harness';
import { agent, baseTask as base, human, createTaskHarness as setup } from '../../testing/tasks';

describe('task lifecycle', () => {
  it('routes a new task to an online owner of its area and briefs only them', async () => {
    const { tasks, drain } = setup();
    const task = tasks.create({ ...base, area: 'api' }, human('bob'));
    expect(task.state).toBe('assigned');
    expect(['alice-agent', 'carol-agent']).toContain(task.assignee);
    const inbox = await drain();
    const brief = inbox.get(task.assignee ?? '') ?? [];
    expect(brief).toHaveLength(1);
    expect(brief[0]?.body).toContain('suggested branch');
    expect(brief[0]?.body).toContain('task_act(task_id: "task-1", action: "accept")');
    expect(inbox.get('bob-agent')).toBeUndefined();
  });

  it('spreads work across owners and respects capacity, then uses the board', async () => {
    const { tasks, drain, ctx } = setup();
    ctx.index.config.assignment.maxActiveTasksPerAgent = 1;
    const first = tasks.create({ ...base, area: 'api' }, human('bob'));
    const second = tasks.create({ ...base, area: 'api' }, human('bob'));
    expect(new Set([first.assignee, second.assignee])).toEqual(
      new Set(['alice-agent', 'carol-agent']),
    );
    await drain();
    const third = tasks.create({ ...base, area: 'api', labels: ['backend'] }, human('bob'));
    expect(third.assignee).toBeNull();
    expect(third.state).toBe('backlog');
    const inbox = await drain();
    expect(inbox.get('alice-agent')?.[0]?.body).toContain('claim');
    expect(inbox.get('alice-agent')?.[0]?.class).toBe('status');
    expect(inbox.get('bob-agent')).toBeUndefined();
  });

  it('reassigns a declined task to the other owner and never back to the decliner', () => {
    const { tasks } = setup();
    const task = tasks.create({ ...base, area: 'api' }, human('bob'));
    const first = task.assignee ?? '';
    const after = tasks.act(1, 'decline', { note: 'swamped' }, agent(first));
    expect(after.assignee).not.toBe(first);
    expect(after.state).toBe('assigned');
    const second = after.assignee ?? '';
    const final = tasks.act(1, 'decline', { note: 'not my area' }, agent(second));
    expect(final.assignee).toBeNull();
    expect(final.state).toBe('backlog');
  });

  it('lets an agent claim a board task', () => {
    const { tasks } = setup([]);
    tasks.create({ ...base, labels: ['nothing-matches'] }, human('alice'));
    const claimed = tasks.act(1, 'claim', {}, agent('bob-agent'));
    expect(claimed.assignee).toBe('bob-agent');
    expect(claimed.state).toBe('assigned');
  });

  it('honours an explicit assignee', () => {
    const { tasks } = setup();
    const task = tasks.create({ ...base, area: 'api', assignee: 'bob-agent' }, human('alice'));
    expect(task.assignee).toBe('bob-agent');
  });

  it('holds dependent tasks until their dependencies are done', async () => {
    const { tasks } = setup();
    const a = tasks.create({ ...base, area: 'web' }, human('alice'));
    const b = tasks.create({ ...base, area: 'web', dependsOn: [1] }, human('alice'));
    expect(b.assignee).toBeNull();
    const owner = agent(a.assignee ?? '');
    tasks.act(1, 'accept', {}, owner);
    tasks.act(1, 'submit', { prUrl: 'https://github.com/acme/web/pull/1' }, owner);
    const reviewer = tasks.get(1, owner).reviewers[0] ?? '';
    tasks.submitReview(1, 'approve', 'LGTM', agent(reviewer));
    tasks.act(1, 'complete', {}, owner);
    expect(tasks.get(2, owner).assignee).toBe('bob-agent');
  });
});

describe('review loop', () => {
  it('runs submit → changes requested → resubmit → approve → done', async () => {
    const { tasks, drain, leases, messaging } = setup();
    const task = tasks.create({ ...base, area: 'api' }, human('bob'));
    const owner = agent(task.assignee ?? '');
    tasks.act(1, 'accept', {}, owner);

    expect(() => tasks.act(1, 'submit', {}, owner)).toThrow(/requires: prUrl/);
    const submitted = tasks.act(
      1,
      'submit',
      { prUrl: 'https://github.com/acme/api/pull/7' },
      owner,
    );
    expect(submitted.state).toBe('in_review');
    expect(submitted.reviewers).not.toContain(owner.id);
    const reviewer = agent(submitted.reviewers[0] ?? '');
    expect((await drain()).get(reviewer.id)?.map((m) => [m.refs.action, m.class])).toEqual([
      ['review_requested', 'action'],
    ]);

    const changes = tasks.submitReview(1, 'request_changes', 'Missing tests', reviewer);
    expect(changes.state).toBe('changes_requested');
    expect((await drain()).get(owner.id)?.some((m) => m.body.includes('changes requested'))).toBe(
      true,
    );

    const again = tasks.act(1, 'submit', {}, owner);
    expect(again.reviewRound).toBe(2);
    expect(again.reviewers).toEqual(submitted.reviewers);
    expect(tasks.submitReview(1, 'approve', 'Good now', reviewer).state).toBe('approved');

    const done = tasks.act(1, 'complete', {}, owner);
    expect(done.state).toBe('done');
    expect(done.terminal).toBe(true);
    expect(leases.releasedTasks).toEqual([1]);
    expect(messaging.thread(1).status).toBe('closed');
    expect(done.history.map((h) => h.action)).toEqual([
      'create',
      'assign',
      'accept',
      'submit',
      'request_changes',
      'submit',
      'approve',
      'complete',
    ]);
  });

  it('lets only current reviewers (or humans) submit verdicts', () => {
    const { tasks } = setup();
    const task = tasks.create({ ...base, area: 'api' }, human('bob'));
    const owner = agent(task.assignee ?? '');
    tasks.act(1, 'accept', {}, owner);
    tasks.act(1, 'submit', { prUrl: 'https://x/pr/1' }, owner);
    expect(() => tasks.submitReview(1, 'approve', 'self', owner)).toThrow(/not a reviewer/);
    expect(tasks.submitReview(1, 'approve', 'ok', human('alice')).state).toBe('approved');
  });

  it('keeps going when a reviewer leaves the team mid-review', async () => {
    const { tasks, drain, ctx } = setup();
    const reviewers = ['bob-agent', 'carol-agent'];
    tasks.create({ ...base, area: 'api', assignee: 'alice-agent', reviewers }, human('bob'));
    const owner = agent('alice-agent');
    tasks.act(1, 'accept', {}, owner);
    expect(tasks.act(1, 'submit', { prUrl: 'https://x/pr/1' }, owner).reviewers).toEqual(reviewers);
    await drain();

    leaveTeam(ctx, 'carol');
    const reviewer = agent('bob-agent');
    expect(tasks.submitReview(1, 'request_changes', 'Missing tests', reviewer).state).toBe(
      'changes_requested',
    );
    expect(tasks.act(1, 'submit', {}, owner).reviewers).toEqual(['bob-agent']);
    expect(tasks.submitReview(1, 'approve', 'Good now', reviewer).state).toBe('approved');
    expect((await drain()).has('carol-agent')).toBe(false);
  });
});

describe('human reviewers who join by invite', () => {
  it('are added to reviews only once they have joined', () => {
    const { tasks, ctx } = setup();
    ctx.index.config.review.humanReviewers = ['dana'];
    const reviewers = ['bob-agent'];
    tasks.create({ ...base, area: 'api', assignee: 'alice-agent', reviewers }, human('bob'));
    const owner = agent('alice-agent');
    tasks.act(1, 'accept', {}, owner);
    expect(tasks.act(1, 'submit', { prUrl: 'https://x/pr/1' }, owner).reviewers).toEqual(reviewers);
    tasks.submitReview(1, 'request_changes', 'Missing tests', agent('bob-agent'));
    joinTeam(ctx, 'dana');
    expect(tasks.act(1, 'submit', {}, owner).reviewers).toEqual(['bob-agent', 'dana']);
  });
});

describe('permissions and errors', () => {
  it('refuses actions from the wrong role and explains invalid ones', () => {
    const { tasks } = setup();
    const task = tasks.create({ ...base, area: 'api' }, agent('bob-agent'));
    const stranger = task.assignee === 'alice-agent' ? 'carol-agent' : 'alice-agent';
    expect(() => tasks.act(1, 'accept', {}, agent(stranger))).toThrow(/for: assignee/);
    expect(() => tasks.act(1, 'cancel', {}, agent(stranger))).toThrow(/for: creator, human/);
    expect(() => tasks.act(1, 'fly', {}, agent(task.assignee ?? ''))).toThrow(
      /Actions available to you: .*accept/,
    );
    expect(tasks.act(1, 'cancel', { note: 'dup' }, agent('bob-agent')).state).toBe('cancelled');
  });

  it('rejects unknown workflows, areas and assignees', () => {
    const { tasks } = setup();
    expect(() => tasks.create({ ...base, workflow: 'nope' }, human('bob'))).toThrow(/workflow/);
    expect(() => tasks.create({ ...base, area: 'nope' }, human('bob'))).toThrow(/area/);
    expect(() => tasks.create({ ...base, assignee: 'bob' }, human('bob'))).toThrow(/agent/);
  });
});
