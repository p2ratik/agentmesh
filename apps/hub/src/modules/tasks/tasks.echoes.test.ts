import { describe, expect, it } from 'vitest';
import type { Actor } from '../../contracts';
import { agent, baseTask as base, human, createTaskHarness as setup } from '../../testing/tasks';

/** What bob-agent is told about its own assignment of task-N (default git config). */
const branchNote = (n: number) =>
  `task-${n}: base branch \`agents\` · suggested branch ` +
  `\`agent/bob/task-${n}-add-retries-to-the-queue-consumer\` · work in a separate git worktree.`;

/** Agent calls made over RPC pass their notes; then their own call is never echoed back to them. */
describe('echoes and classes', () => {
  it('a reviewer is not echoed the approval its review triggered', async () => {
    const { tasks, drain } = setup();
    const reviewers = ['carol-agent'];
    tasks.create({ ...base, area: 'api', assignee: 'alice-agent', reviewers }, human('bob'));
    const owner = agent('alice-agent');
    tasks.act(1, 'accept', {}, owner, []);
    tasks.act(1, 'submit', { prUrl: 'https://x/pr/1' }, owner, []);
    await drain();
    expect(tasks.submitReview(1, 'approve', 'LGTM', agent('carol-agent'), []).state).toBe(
      'approved',
    );
    const inbox = await drain();
    expect(inbox.get('carol-agent')).toBeUndefined();
    expect(inbox.get('alice-agent')?.map((m) => m.refs.action)).toEqual([
      'review_submitted',
      'approve',
    ]);
  });

  it('a cancel tells a reviewer still owing a verdict as action, and one who gave it as status', async () => {
    const { tasks, drain } = setup();
    const reviewers = ['carol-agent', 'bob-agent'];
    tasks.create({ ...base, area: 'api', assignee: 'alice-agent', reviewers }, human('bob'));
    const owner = agent('alice-agent');
    tasks.act(1, 'accept', {}, owner, []);
    tasks.act(1, 'submit', { prUrl: 'https://x/pr/1' }, owner, []);
    tasks.submitReview(1, 'comment', 'Looking', agent('carol-agent'), []);
    tasks.submitReview(1, 'approve', 'LGTM', agent('bob-agent'), []);
    await drain();
    tasks.act(1, 'cancel', { note: 'superseded' }, human('bob'));
    const inbox = await drain();
    const cancel = (id: string) => inbox.get(id)?.find((m) => m.refs.action === 'cancel')?.class;
    expect([cancel('carol-agent'), cancel('bob-agent')]).toEqual(['action', 'status']);
  });

  it('a creator assigning the task to itself gets no brief', async () => {
    const { tasks, drain } = setup();
    const self = agent('bob-agent');
    const notes: string[] = [];
    const task = tasks.create({ ...base, area: 'web', assignee: 'bob-agent' }, self, notes);
    expect(task.assignee).toBe('bob-agent');
    expect(notes).toEqual([branchNote(1)]);
    expect((await drain()).get('bob-agent')).toBeUndefined();
  });

  it("the assignee's verdict notice is action and the creator's copy is status", async () => {
    const { tasks, drain } = setup();
    const reviewers = ['carol-agent'];
    tasks.create({ ...base, area: 'api', assignee: 'alice-agent', reviewers }, agent('bob-agent'));
    const owner = agent('alice-agent');
    tasks.act(1, 'accept', {}, owner, []);
    tasks.act(1, 'submit', { prUrl: 'https://x/pr/1' }, owner, []);
    await drain();
    tasks.submitReview(1, 'request_changes', 'Missing tests', agent('carol-agent'), []);
    const inbox = await drain();
    const verdict = (id: string) =>
      inbox.get(id)?.find((m) => m.refs.action === 'review_submitted')?.class;
    expect(verdict('alice-agent')).toBe('action');
    expect(verdict('bob-agent')).toBe('status');
  });

  it('a creator assigning the task to itself gets its branch as a note', async () => {
    const { tasks, drain } = setup();
    const notes: string[] = [];
    // Here the hub routes it to the creator (the owner of area web); the test above names it.
    const task = tasks.create({ ...base, area: 'web' }, agent('bob-agent'), notes);
    expect(task.assignee).toBe('bob-agent');
    expect(notes).toEqual([branchNote(1)]);
    expect((await drain()).get('bob-agent')).toBeUndefined();
  });

  it('a self-claim gets its branch as a note, not a delivery', async () => {
    const { tasks, drain } = setup([]);
    tasks.create({ ...base, labels: ['nothing-matches'] }, human('alice'));
    await drain();
    const notes: string[] = [];
    expect(tasks.act(1, 'claim', {}, agent('bob-agent'), notes).assignee).toBe('bob-agent');
    expect(notes).toEqual([branchNote(1)]);
    expect((await drain()).get('bob-agent')).toBeUndefined();
  });

  it('an unblock by someone else interrupts the assignee', async () => {
    const { tasks, drain } = setup();
    tasks.create({ ...base, area: 'api', assignee: 'alice-agent' }, agent('bob-agent'));
    const owner = agent('alice-agent');
    tasks.act(1, 'accept', {}, owner, []);
    tasks.act(1, 'block', { note: 'needs a staging key' }, owner, []);
    await drain();
    tasks.act(1, 'unblock', {}, agent('bob-agent'), []);
    const got = (await drain()).get('alice-agent');
    expect(got?.map((m) => [m.refs.action, m.class])).toEqual([['unblock', 'action']]);
  });

  it('a task assigned away from an agent tells that agent as action', async () => {
    const { tasks, drain } = setup();
    tasks.create({ ...base, area: 'api', assignee: 'alice-agent' }, agent('bob-agent'));
    await drain();
    tasks.act(1, 'assign', { to: 'carol-agent', note: 'alice is out' }, human('bob'));
    const inbox = await drain();
    expect(inbox.get('alice-agent')?.map((m) => m.class)).toEqual(['action']);
    expect(inbox.get('carol-agent')?.map((m) => m.class)).toEqual(['action']);
    expect(inbox.get('bob-agent')?.map((m) => m.class)).toEqual(['status']);
  });

  /** Task-1 from accept to done, every call over RPC; returns what its assignee got about task-2. */
  async function finishTask1(h: ReturnType<typeof setup>, owner: Actor) {
    await h.drain();
    h.tasks.act(1, 'accept', {}, owner, []);
    h.tasks.act(1, 'submit', { prUrl: 'https://x/pr/1' }, owner, []);
    h.tasks.submitReview(1, 'approve', 'ok', agent(h.tasks.get(1, owner).reviewers[0] ?? ''), []);
    h.tasks.act(1, 'complete', {}, owner, []);
    const got = (await h.drain()).get(owner.id) ?? [];
    return got.filter((m) => m.refs.taskId === 'task-2').map((m) => [m.refs.action, m.class]);
  }

  it('completing a task still tells the completer its dependent task is ready', async () => {
    const h = setup();
    h.tasks.create({ ...base, area: 'web' }, human('alice'));
    h.tasks.create({ ...base, area: 'web', assignee: 'bob-agent', dependsOn: [1] }, human('alice'));
    expect(await finishTask1(h, agent('bob-agent'))).toEqual([['dependencies_done', 'action']]);
  });

  it('a dependent auto-assigned to the completer still gets its brief', async () => {
    const h = setup();
    h.tasks.create({ ...base, area: 'web' }, human('alice'));
    h.tasks.create({ ...base, area: 'web', dependsOn: [1] }, human('alice'));
    expect(await finishTask1(h, agent('bob-agent'))).toEqual([['assign', 'action']]);
  });
});
