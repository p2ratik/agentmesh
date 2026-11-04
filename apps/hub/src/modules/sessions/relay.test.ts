import { describe, expect, it } from 'vitest';
import { type RelayInput, RelayMarks, relayTarget } from './relay';
import type { RouteSession } from './routing';

const s = (over: Partial<RouteSession> & { id: string }): RouteSession => ({
  active: true,
  liveness: 'live',
  delivery: 'push',
  repo: null,
  activatedAt: '2026-10-21T09:00:00Z',
  meshWindow: false,
  clientVersion: '0.6.0',
  ...over,
});
const w = s({ id: 'w', meshWindow: true });
const p = s({ id: 'p', active: false, activatedAt: null });

const message: RelayInput['message'] = {
  kind: 'reply',
  class: 'action',
  trust: 'team',
  from: { id: 'alice-agent', kind: 'agent', displayName: 'Alice' },
};
const input = (over: Partial<RelayInput> = {}): RelayInput => ({
  message,
  threadOwner: 'p',
  sessions: [w, p],
  ...over,
});

describe('relayTarget', () => {
  it('relays an action reply for an inactive live direct owner through a 0.6.0 mesh window', () => {
    expect(relayTarget(input())).toEqual({
      windowId: 'w',
      forSession: 'p',
      reason: 'relay to w for inactive p',
    });
  });

  it('relays no status reply, ask, external message or service message', () => {
    const service = { id: 'hub', kind: 'service', displayName: 'Hub' } as const;
    for (const over of [
      { class: 'status' },
      { kind: 'ask' },
      { trust: 'external' },
      { from: service },
    ] as const) {
      expect(relayTarget(input({ message: { ...message, ...over } }))).toBeNull();
    }
  });

  it('relays nothing for an active, away or missing owner', () => {
    expect(relayTarget(input({ sessions: [w, { ...p, active: true }] }))).toBeNull();
    expect(relayTarget(input({ sessions: [w, { ...p, liveness: 'away' }] }))).toBeNull();
    expect(relayTarget(input({ threadOwner: null }))).toBeNull();
    expect(relayTarget(input({ threadOwner: 'gone' }))).toBeNull();
  });

  it('needs a ready push mesh window at 0.6.0 or later', () => {
    const withWindow = (over: Partial<RouteSession>) =>
      relayTarget(input({ sessions: [{ ...w, ...over }, p] }));
    expect(withWindow({ clientVersion: '0.5.0' })).toBeNull();
    expect(withWindow({ clientVersion: '0.5.9' })).toBeNull();
    expect(withWindow({ delivery: 'pull' })).toBeNull();
    expect(withWindow({ liveness: 'away' })).toBeNull();
    expect(withWindow({ clientVersion: '0.10.0' })?.windowId).toBe('w');
  });

  it('marks one pointer per thread and session until the thread is cleared', () => {
    const marks = new RelayMarks();
    marks.set('bob-agent', 'thr-1', 'p');
    expect(marks.has('bob-agent', 'thr-1', 'p')).toBe(true);
    expect(marks.has('bob-agent', 'thr-1', 'q')).toBe(false);
    expect(marks.has('bob-agent', 'thr-2', 'p')).toBe(false);
    expect(marks.has('carol-agent', 'thr-1', 'p')).toBe(false);
    marks.set('bob-agent', 'thr-1', 'q');
    marks.clearThread('bob-agent', 'thr-1');
    expect(marks.has('bob-agent', 'thr-1', 'p')).toBe(false);
    expect(marks.has('bob-agent', 'thr-1', 'q')).toBe(false);
  });

  it('deletes one mark and keeps the thread’s others', () => {
    const marks = new RelayMarks();
    marks.set('bob-agent', 'thr-1', 'p');
    marks.set('bob-agent', 'thr-1', 'q');
    marks.delete('bob-agent', 'thr-1', 'p');
    expect(marks.has('bob-agent', 'thr-1', 'p')).toBe(false);
    expect(marks.has('bob-agent', 'thr-1', 'q')).toBe(true);
  });
});
