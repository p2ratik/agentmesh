import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../rpc/idempotency';
import { createRpcRouter } from '../../rpc/router';
import { testTeamConfig } from '../../testing/fixtures';
import { leaveTeam } from '../../testing/harness';
import { createServiceHarness } from '../../testing/services';
import { createTaskModule } from './index';

function setup(loaded = testTeamConfig()) {
  const h = createServiceHarness(loaded, { online: ['alice-agent', 'bob-agent', 'carol-agent'] });
  const module = createTaskModule(h.ctx, {
    messaging: h.messaging,
    presence: h.presence,
    leases: h.leases,
  });
  h.presence.setLoadReader(() => module.service.activeLoad());
  const dispatch = createRpcRouter({
    index: () => h.ctx.index,
    handlers: module.handlers,
    idempotency: new IdempotencyStore(h.ctx.db, h.clock),
    logger: h.ctx.logger,
    transaction: (fn) => h.ctx.db.transaction(fn),
  });
  const call = (caller: string, method: string, params: unknown, actAs?: string) =>
    dispatch({ caller, method, ...(actAs ? { actAs } : {}) }, params) as Promise<
      Record<string, unknown>
    >;
  return { ...h, call, dispatch };
}

describe('task RPC handlers', () => {
  it('creates, lists "me" and acts through protocol ids', async () => {
    const { call } = setup();
    const created = await call(
      'discord-bridge',
      'task.create',
      { title: 'Fix login', area: 'web' },
      'alice',
    );
    expect(created.id).toBe('task-1');
    expect(created.assignee).toBe('bob-agent');
    const mine = (await call('bob-agent', 'task.list', { assignee: 'me' })).tasks as unknown[];
    expect(mine).toHaveLength(1);
    const accepted = await call('bob-agent', 'task.act', { taskId: 'TASK-1', action: 'accept' });
    expect(accepted.state).toBe('in_progress');
    expect(accepted.availableActions).toEqual(
      expect.arrayContaining(['block', 'submit', 'handoff']),
    );
  });

  it('runs a stand-alone review request with pinned reviewers', async () => {
    const { call, drain } = setup();
    const review = await call('alice-agent', 'review.request', {
      prUrl: 'https://github.com/acme/api/pull/9',
      focus: 'retry logic',
      reviewers: ['bob-agent'],
    });
    expect(review.workflow).toBe('review');
    expect(review.state).toBe('in_review');
    expect(review.assignee).toBe('alice-agent');
    expect(review.reviewers).toEqual(['bob-agent']);
    expect((await drain()).get('bob-agent')?.[0]?.body).toContain('retry logic');
    const approved = await call('bob-agent', 'review.submit', {
      taskId: review.id,
      verdict: 'approve',
      body: 'looks good',
    });
    expect(approved.state).toBe('approved');
    expect(
      (await call('alice-agent', 'task.act', { taskId: review.id, action: 'complete' })).state,
    ).toBe('done');
  });

  it('an agent whose submit finds no reviewer gets a note, not a delivery', async () => {
    const { call, dispatch, drain, ctx } = setup();
    await call('discord-bridge', 'task.create', { title: 'Fix login', area: 'web' }, 'bob');
    await call('bob-agent', 'task.act', { taskId: 'task-1', action: 'accept' });
    leaveTeam(ctx, 'alice');
    leaveTeam(ctx, 'carol');
    await drain();
    const notes: string[] = [];
    const params = { taskId: 'task-1', action: 'submit', prUrl: 'https://x/pr/1' };
    await dispatch({ caller: 'bob-agent', method: 'task.act', notes }, params);
    expect(notes).toEqual(['No reviewer was found for task-1; request one with request_review.']);
    expect((await drain()).get('bob-agent')).toBeUndefined();
  });

  it('hides terminal tasks unless asked', async () => {
    const { call } = setup();
    await call('alice-agent', 'task.create', { title: 'Temp task', area: 'web' });
    await call('alice-agent', 'task.act', { taskId: 'task-1', action: 'cancel', note: 'dup' });
    expect(((await call('alice-agent', 'task.list', {})).tasks as unknown[]).length).toBe(0);
    const all = (await call('alice-agent', 'task.list', { includeTerminal: true }))
      .tasks as unknown[];
    expect(all).toHaveLength(1);
  });
});

describe('custom workflows from config', () => {
  it('drives a team-defined state machine with built-in effects', async () => {
    const loaded = testTeamConfig({
      tasks: { defaultWorkflow: 'triage' },
      workflows: [
        {
          id: 'triage',
          initial: 'new',
          states: {
            new: { onEnter: ['auto_assign'] },
            owned: { onEnter: ['notify_assignee'] },
            fixed: { terminal: true, onEnter: ['notify_creator', 'close_thread'] },
          },
          transitions: [
            { action: 'assign', from: ['new'], to: 'owned', by: ['system'], requires: ['to'] },
            { action: 'fix', from: ['owned'], to: 'fixed', by: ['assignee'], requires: ['note'] },
          ],
        },
      ],
    });
    const { call, drain } = setup(loaded);
    const task = await call('carol-agent', 'task.create', { title: 'Prod 500s', area: 'web' });
    expect(task.workflow).toBe('triage');
    expect(task.state).toBe('owned');
    expect(task.assignee).toBe('bob-agent');
    await drain();
    await expect(
      call('bob-agent', 'task.act', { taskId: 'task-1', action: 'fix' }),
    ).rejects.toThrow(/note/);
    const fixed = await call('bob-agent', 'task.act', {
      taskId: 'task-1',
      action: 'fix',
      note: 'rolled back',
    });
    expect(fixed.state).toBe('fixed');
    expect((await drain()).get('carol-agent')?.[0]?.body).toContain('fixed');
  });
});
