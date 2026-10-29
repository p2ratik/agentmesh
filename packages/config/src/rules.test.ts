import { describe, expect, it } from 'vitest';
import { CreateTaskAction, NotifyAction } from './schema/rules';

describe('notify rule action', () => {
  it('a notify rule defaults to class action and accepts status', () => {
    const base = { to: 'online', text: 'hi' };
    expect(NotifyAction.parse({ notify: base }).notify.class).toBe('action');
    expect(NotifyAction.parse({ notify: { ...base, class: 'status' } }).notify.class).toBe(
      'status',
    );
    expect(NotifyAction.safeParse({ notify: { ...base, class: 'loud' } }).success).toBe(false);
  });
});

describe('create_task rule action', () => {
  it('refuses a template in assignee or area: an event must not pick who gets the work', () => {
    const task = (extra: object) =>
      CreateTaskAction.safeParse({ create_task: { title: 't', ...extra } });
    for (const field of ['assignee', 'area']) {
      const refused = task({ [field]: '{{ payload.owner }}' });
      expect(refused.success).toBe(false);
      expect(refused.error?.issues[0]?.message).toMatch(/configured id, not a \{\{template\}\}/);
      expect(task({ [field]: 'api' }).success).toBe(true);
    }
    expect(task({ repo: '{{payload.repo}}' }).success).toBe(true);
  });
});
