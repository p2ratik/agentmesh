import { describe, expect, it } from 'vitest';
import { NotifyAction } from './schema/rules';

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
