import type { MeshMessage } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { RecentIds } from './recent-ids';
import { renderEvent, sanitizeMeta } from './render';

const message = (
  id: string,
  threadId = 'thr-1',
  extra: Partial<MeshMessage> = {},
): MeshMessage => ({
  id,
  threadId,
  kind: 'ask',
  from: { id: 'bob-agent', kind: 'agent', displayName: "Bob's agent" },
  to: ['alice-agent'],
  subject: 'Render\nqueue',
  body: `body ${id}`,
  status: null,
  trust: 'team',
  depth: 1,
  refs: { taskId: 'task-4' },
  createdAt: `2026-10-16T09:0${id.slice(-1)}:00.000Z`,
  ...extra,
});

describe('renderEvent', () => {
  it('renders one message as its body with identifier-only string meta', () => {
    const event = renderEvent([message('m1')]);
    expect(event.content).toBe('body m1');
    expect(event.meta).toEqual({
      thread_id: 'thr-1',
      message_id: 'm1',
      from: 'bob-agent',
      from_name: "Bob's agent",
      from_kind: 'agent',
      kind: 'ask',
      task_id: 'task-4',
      trust: 'team',
      depth: '1',
      subject: 'Render queue',
    });
  });

  it('bundles several messages into a transcript and flags any external content', () => {
    const event = renderEvent([
      message('m1'),
      message('m2', 'thr-1', { trust: 'external', status: 'blocked' }),
    ]);
    expect(event.content).toMatch(/^2 new messages in thr-1/);
    expect(event.content).toContain('blocked, external');
    expect(event.meta.count).toBe('2');
    expect(event.meta.trust).toBe('external');
    expect(event.meta.message_id).toBe('m2');
  });

  it('truncates long content and points to the thread tool', () => {
    const event = renderEvent([message('m1', 'thr-9', { body: 'x'.repeat(500) })], 100);
    expect(event.content).toContain('thread(thread_id: "thr-9")');
  });

  it('drops keys Claude Code would silently discard', () => {
    expect(sanitizeMeta({ 'bad-key': 'x', ok_key: 'y', '1x': 'z', empty: '', none: null })).toEqual(
      { ok_key: 'y' },
    );
  });
});

describe('RecentIds', () => {
  it('remembers a bounded number of ids', () => {
    const ids = new RecentIds(2);
    expect(ids.remember('a')).toBe(true);
    expect(ids.remember('a')).toBe(false);
    ids.remember('b');
    ids.remember('c');
    expect(ids.remember('a')).toBe(true);
  });
});
