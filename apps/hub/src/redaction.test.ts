import { ConfigIndex } from '@agentmesh/config';
import { Plan, type PlanTaskDraft, type RpcParams } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { Actor, CallContext } from './contracts';
import { internalId } from './core/ids';
import type { MessagingServiceImpl } from './modules/messaging/messaging.service';
import { sendHandlers } from './modules/messaging/send.handlers';
import { PlanningServiceImpl } from './modules/planning/planning.service';
import { taskHandlers } from './modules/tasks/handlers';
import type { TaskRecord } from './modules/tasks/repo';
import { TaskServiceImpl } from './modules/tasks/tasks.service';
import { suggestedBranch } from './modules/tasks/text';
import { testTeamConfig } from './testing/fixtures';
import { createServiceHarness } from './testing/services';

/** Assembled at runtime so repository secret scanners never flag this file. */
const TOKEN = ['ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('');

/**
 * A line with the token starting at `at`. Each test picks `at` so the hub's cut
 * lands inside the raw token (too short to match its pattern afterwards) but
 * after the whole `[REDACTED]` once the token is masked.
 */
const tokenAt = (at: number) => `${'a'.repeat(at - 1)} ${TOKEN} and more`;

const agent = (id: string): Actor => ({ id, kind: 'agent', roles: [] });
const alice: Actor = { id: 'alice', kind: 'human', roles: ['admin'] };

function setup() {
  const h = createServiceHarness(undefined, {
    online: ['alice-agent', 'bob-agent', 'carol-agent'],
  });
  const messaging = h.messaging as MessagingServiceImpl;
  const tasks = new TaskServiceImpl(h.ctx, { messaging, presence: h.presence, leases: h.leases });
  h.presence.setLoadReader(() => tasks.activeLoad());
  const planning = new PlanningServiceImpl(h.ctx, { messaging, tasks, presence: h.presence });
  return {
    messaging,
    tasks,
    planning,
    send: sendHandlers(messaging),
    taskRpc: taskHandlers(tasks),
  };
}

const call = (actor: Actor, method: CallContext['method']): CallContext => ({
  actor,
  caller: actor,
  method,
});

const expectMasked = (text: string | null | undefined) => {
  expect(text).not.toContain('ghp_');
  expect(text).toContain('[REDACTED]');
};

// The bridge masks what it posts, but cannot recognise a token the hub has already cut short.
describe('the hub redacts text before it cuts it', () => {
  it('in a subject taken from the first line of an ask (80 characters)', async () => {
    const s = setup();
    const params = { kind: 'ask', to: ['bob-agent'], body: tokenAt(60) };
    const sent = await s.send['message.send'](
      params as RpcParams<'message.send'>,
      call(agent('alice-agent'), 'message.send'),
    );
    expectMasked(s.messaging.thread(internalId('thread', sent.threadId)).subject);
  });

  it('in a subject taken from an escalation question (80 characters)', async () => {
    const s = setup();
    const escalated = await s.send.escalate(
      { question: tokenAt(60) } as RpcParams<'escalate'>,
      call(agent('alice-agent'), 'escalate'),
    );
    expectMasked(s.messaging.thread(internalId('thread', escalated.threadId)).subject);
  });

  it('in an explicit thread subject (120 characters)', async () => {
    const s = setup();
    const params = { kind: 'ask', to: ['bob-agent'], subject: tokenAt(100), body: 'hi' };
    const sent = await s.send['message.send'](
      params as RpcParams<'message.send'>,
      call(agent('alice-agent'), 'message.send'),
    );
    expectMasked(s.messaging.thread(internalId('thread', sent.threadId)).subject);
  });

  it('in a plan thread subject (80 characters)', () => {
    const s = setup();
    const plan = s.planning.start({ topic: tokenAt(54) }, alice);
    expectMasked(s.messaging.thread(internalId('thread', plan.threadId)).subject);
  });

  it('in the note a request_changes review leaves on the transition (200 characters)', () => {
    const s = setup();
    const created = s.tasks.create(
      {
        title: 'Add retries',
        description: '',
        priority: 'normal',
        labels: [],
        dependsOn: [],
        area: 'api',
      },
      alice,
    );
    const owner = agent(created.assignee ?? '');
    s.tasks.act(1, 'accept', {}, owner);
    const submitted = s.tasks.act(1, 'submit', { prUrl: 'https://x/pr/1' }, owner);
    const reviewer = agent(submitted.reviewers[0] ?? '');
    const task = s.tasks.submitReview(1, 'request_changes', tokenAt(180), reviewer);
    expectMasked(task.history.find((h) => h.action === 'request_changes')?.note);
  });

  // createThread only cuts, so a title is redacted where it comes in. Its thread subject is the
  // title cut to 120.
  it('in a task title from task.create', async () => {
    const s = setup();
    const params = { title: tokenAt(100), description: '', priority: 'normal', labels: [] };
    const task = await s.taskRpc['task.create'](
      { ...params, dependsOn: [] } as RpcParams<'task.create'>,
      call(alice, 'task.create'),
    );
    expectMasked(s.messaging.thread(internalId('thread', task.threadId)).subject);
  });

  it('in a review task title from review.request', async () => {
    const s = setup();
    const task = await s.taskRpc['review.request'](
      { prUrl: 'https://x/pr/1', title: tokenAt(100) } as RpcParams<'review.request'>,
      call(agent('alice-agent'), 'review.request'),
    );
    expectMasked(s.messaging.thread(internalId('thread', task.threadId)).subject);
  });

  it('in a plan draft title, which becomes a task title', () => {
    const s = setup();
    s.planning.start({ topic: 'Render status' }, alice);
    const draft = { key: 'a', title: tokenAt(100), description: '', dependsOn: [] };
    s.planning.submit(1, 'ok', [draft as PlanTaskDraft], alice);
    const task = s.tasks.get(1, alice);
    expectMasked(s.messaging.thread(internalId('thread', task.threadId)).subject);
  });

  it('keeps a masked plan draft title within the 200 characters a Plan allows', () => {
    const s = setup();
    s.planning.start({ topic: 'Render status' }, alice);
    // Masking lengthens it: `token: expiry` becomes `token: [REDACTED]`, 204 characters in all.
    // Over 200, the RPC client and the bridge could no longer parse the plan.
    const draft = { key: 'a', title: `${'a'.repeat(186)} token: expiry`, description: '' };
    const plan = s.planning.submit(1, 'ok', [{ ...draft, dependsOn: [] } as PlanTaskDraft], alice);
    expect(() => Plan.parse(plan)).not.toThrow();
    expect(plan.drafts[0]?.title).not.toContain('expiry');
  });

  it('in the branch name the assignment brief suggests (the slug is cut to 40)', () => {
    const index = new ConfigIndex(testTeamConfig().config);
    const task = { id: 7, title: `Rotate ${TOKEN}` } as TaskRecord;
    expect(suggestedBranch(index, task, 'alice-agent')).toBe('agent/alice/task-7-rotate-redacted');
  });
});
