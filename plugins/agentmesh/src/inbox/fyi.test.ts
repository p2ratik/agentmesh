import type { SessionDelivery } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { FyiBuffer, formatFyi } from './fyi';

const status = (id: string, extra: Partial<SessionDelivery> = {}): SessionDelivery => ({
  id,
  threadId: 'thr-3',
  kind: 'reply',
  from: { id: 'bob-agent', kind: 'agent', displayName: "Bob's agent" },
  to: ['alice-agent'],
  subject: 'Billing v2',
  body: `progress ${id}`,
  status: 'working',
  trust: 'team',
  depth: 1,
  refs: {},
  createdAt: '2026-10-22T09:00:00.000Z',
  class: 'status',
  ...extra,
});

describe('FyiBuffer', () => {
  it('keeps the newest 50, counts the dropped ones, and empties on take', () => {
    const fyi = new FyiBuffer();
    fyi.add(Array.from({ length: 30 }, (_, i) => status(`m${i}`)));
    fyi.add(Array.from({ length: 23 }, (_, i) => status(`m${30 + i}`)));
    const taken = fyi.take();
    expect(taken.ids).toHaveLength(50);
    expect(taken.ids[0]).toBe('m3');
    expect(taken.ids.at(-1)).toBe('m52');
    expect(taken.dropped).toBe(3);
    expect(fyi.take()).toEqual({ lines: [], ids: [], dropped: 0 });
  });
});

describe('formatFyi', () => {
  it('prints one line per item: thread, clipped subject, first line of the body', () => {
    const fyi = new FyiBuffer();
    fyi.add([
      status('m1'),
      status('m2', {
        threadId: 'thr-9',
        subject: `Long\nsubject ${'s'.repeat(80)}`,
        body: `\n  ${'b'.repeat(120)}\nsecond line`,
      }),
    ]);
    expect(formatFyi(fyi.take())).toBe(
      [
        'FYI (2):',
        '· thr-3 «Billing v2» progress m1',
        `· thr-9 «Long subject ${'s'.repeat(47)}» ${'b'.repeat(100)}`,
      ].join('\n'),
    );
  });

  it('ends with the dropped count when the cap was hit', () => {
    const fyi = new FyiBuffer();
    fyi.add(Array.from({ length: 52 }, (_, i) => status(`m${i}`)));
    const lines = formatFyi(fyi.take()).split('\n');
    expect(lines[0]).toBe('FYI (50):');
    expect(lines).toHaveLength(52);
    expect(lines.at(-1)).toBe('· …and 2 more: call inbox');
  });

  it('is empty when there is nothing', () => {
    expect(formatFyi(new FyiBuffer().take())).toBe('');
  });
});
