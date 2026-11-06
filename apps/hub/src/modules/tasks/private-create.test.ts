import { describe, expect, it } from 'vitest';
import type { CallContext } from '../../contracts';
import { baseTask as base, human, createTaskHarness as setup } from '../../testing/tasks';
import { taskHandlers } from './handlers';

const branchNote = (n: number) =>
  `task-${n}: base branch \`agents\` · suggested branch ` +
  `\`agent/bob/task-${n}-add-retries-to-the-queue-consumer\` · work in a separate git worktree.`;

const call = (session: string | null, method: CallContext['method']): CallContext => {
  const actor = { id: 'bob-agent', kind: 'agent' as const, roles: [] };
  return { actor, caller: actor, method, session, notes: [] };
};

const params = { ...base, area: 'web', assignee: 'bob-agent' };

describe('a task created by a private session', () => {
  it("a private session's task for its own agent sends the brief", async () => {
    const { tasks, drain } = setup();
    const c = call('s-aaaaaaaaaaaa', 'task.create');
    await taskHandlers(tasks, () => false)['task.create'](params as never, c);
    const bob = (await drain()).get('bob-agent') ?? [];
    expect(bob.some((m) => m.body.includes('suggested branch'))).toBe(true);
    expect(c.notes).toEqual([]);
  });

  it('an active session, or a call with no session, gets its branch as a note and no brief', async () => {
    for (const [active, session] of [
      [true, 's-aaaaaaaaaaaa'],
      [false, null],
    ] as const) {
      const { tasks, drain } = setup();
      const c = call(session, 'task.create');
      await taskHandlers(tasks, () => active)['task.create'](params as never, c);
      expect(c.notes).toEqual([branchNote(1)]);
      expect((await drain()).get('bob-agent')).toBeUndefined();
    }
  });

  it("a private session's task_act stays echo-suppressed", async () => {
    const { tasks, drain } = setup([]);
    tasks.create({ ...base, labels: ['nothing-matches'] }, human('alice'));
    await drain();
    const c = call('s-aaaaaaaaaaaa', 'task.act');
    await taskHandlers(tasks, () => false)['task.act'](
      { taskId: 'task-1', action: 'claim' } as never,
      c,
    );
    expect(c.notes).toEqual([branchNote(1)]);
    expect((await drain()).get('bob-agent')).toBeUndefined();
  });

  it('redacts a task description, from modules calling in too', async () => {
    const { tasks, drain } = setup();
    tasks.create({ ...base, description: 'Use DB_PASSWORD=hunter2-prod to test' }, human('alice'));
    expect(tasks.get(1, human('alice')).description).toBe('Use DB_PASSWORD=[REDACTED] to test');
    // regression guard only: message bodies were already redacted on post
    const all = [...(await drain()).values()].flat();
    expect(all.some((m) => m.body.includes('hunter2-prod'))).toBe(false);
  });
});
