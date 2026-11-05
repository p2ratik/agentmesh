import { describe, expect, it } from 'vitest';
import { type RouteInput, type RouteSession, routeDelivery } from './routing';

const s = (over: Partial<RouteSession> & { id: string }): RouteSession => ({
  active: true,
  liveness: 'live',
  delivery: 'push',
  repo: null,
  activatedAt: '2026-10-21T09:00:00Z',
  meshWindow: false,
  clientVersion: '0.5.0',
  ...over,
});
const s1 = s({ id: 's1' });
const s2 = s({ id: 's2', activatedAt: '2026-10-21T10:00:00Z' });

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  sessions: [s1, s2],
  threadOwner: null,
  parentOwner: null,
  taskOwner: null,
  picked: null,
  repo: null,
  released: null,
  ...over,
});

describe('routeDelivery', () => {
  it('delivers to the active thread owner', () => {
    expect(routeDelivery(input({ threadOwner: 's2' }))).toEqual({
      kind: 'deliver',
      sessionId: 's2',
      claim: false,
      reason: 'owns thread',
    });
  });

  it('holds for an inactive owner', () => {
    const r = routeDelivery(
      input({ sessions: [s({ id: 's1', active: false }), s2], threadOwner: 's1' }),
    );
    expect(r.kind).toBe('wait');
    expect(r.reason).toBe('held for s1 (inactive)');
  });

  it('holds for an away owner', () => {
    const r = routeDelivery(
      input({ sessions: [s({ id: 's1', liveness: 'away' }), s2], threadOwner: 's1' }),
    );
    expect(r).toEqual({ kind: 'wait', reason: 'held for s1 (away)' });
  });

  it('falls back to the parent owner and claims', () => {
    expect(routeDelivery(input({ parentOwner: 's2' }))).toEqual({
      kind: 'deliver',
      sessionId: 's2',
      claim: true,
      reason: 'owns parent thread',
    });
  });

  it('uses the task owner when the thread is unowned', () => {
    expect(routeDelivery(input({ taskOwner: 's2' }))).toEqual({
      kind: 'deliver',
      sessionId: 's2',
      claim: true,
      reason: 'owns task',
    });
  });

  it('owner beats the sender pick', () => {
    const r = routeDelivery(input({ threadOwner: 's1', picked: 's2' }));
    expect(r).toMatchObject({ kind: 'deliver', sessionId: 's1' });
  });

  it('follows the sender pick for unowned work', () => {
    expect(routeDelivery(input({ picked: 's2' }))).toEqual({
      kind: 'deliver',
      sessionId: 's2',
      claim: true,
      reason: 'picked by sender',
    });
  });

  it('prefers a session in the message repo', () => {
    const r = routeDelivery(
      input({ sessions: [s({ id: 's1', repo: 'a/x' }), { ...s2, repo: 'a/y' }], repo: 'a/y' }),
    );
    expect(r).toEqual({ kind: 'deliver', sessionId: 's2', claim: true, reason: 'in repo a/y' });
  });

  it('falls back to the longest-active session', () => {
    expect(routeDelivery(input())).toEqual({
      kind: 'deliver',
      sessionId: 's1',
      claim: true,
      reason: 'longest-active session',
    });
  });

  it('never picks an inactive session by fallback', () => {
    expect(routeDelivery(input({ sessions: [s({ id: 's1', active: false })] }))).toEqual({
      kind: 'wait',
      reason: 'no active push session',
    });
  });

  // A delivery is acked as read and claims its thread: a pull session must never get one.
  describe('pull sessions', () => {
    const pull = s({ id: 's1', delivery: 'pull' });

    it('are never picked by fallback', () => {
      expect(routeDelivery(input({ sessions: [pull, s2] }))).toMatchObject({
        kind: 'deliver',
        sessionId: 's2',
      });
      expect(routeDelivery(input({ sessions: [pull] }))).toEqual({
        kind: 'wait',
        reason: 'no active push session',
      });
    });

    it('keep the threads they own: the work waits for them to read it', () => {
      expect(routeDelivery(input({ sessions: [pull, s2], threadOwner: 's1' }))).toEqual({
        kind: 'wait',
        reason: 'held for s1 (pull)',
      });
    });

    it('keep what a sender picked them for', () => {
      expect(routeDelivery(input({ sessions: [pull, s2], picked: 's1' }))).toEqual({
        kind: 'wait',
        reason: 'held for s1 (picked, pull)',
      });
    });
  });

  it('ignores a closed owner', () => {
    expect(routeDelivery(input({ threadOwner: 's9' }))).toMatchObject({
      kind: 'deliver',
      sessionId: 's1',
    });
  });
});

describe('the mesh window', () => {
  const w = s({ id: 's2', meshWindow: true, activatedAt: '2026-10-21T10:00:00Z' });
  const win = { kind: 'deliver', sessionId: 's2', claim: true, reason: 'mesh window' };
  it('prefers a ready mesh window over a session activated earlier', () => {
    expect(routeDelivery(input({ sessions: [s1, w] }))).toEqual(win);
  });
  it('prefers the mesh window over a session in the task repo', () => {
    const web = s({ id: 's1', repo: 'acme/web' });
    expect(routeDelivery(input({ sessions: [web, w], repo: 'acme/web' }))).toEqual(win);
    const wWeb = { ...w, repo: 'acme/web' };
    expect(routeDelivery(input({ sessions: [web, wWeb], repo: 'acme/web' }))).toEqual(win);
  });
  it('skips a mesh window that is away or pull', () => {
    for (const bad of [{ liveness: 'away' as const }, { delivery: 'pull' as const }]) {
      expect(routeDelivery(input({ sessions: [s1, { ...w, ...bad }] }))).toEqual({
        kind: 'deliver',
        sessionId: 's1',
        claim: true,
        reason: 'longest-active session',
      });
    }
  });
  it('a sender pick and a thread owner still win over the mesh window', () => {
    expect(routeDelivery(input({ sessions: [s1, w], picked: 's1' }))).toMatchObject({
      sessionId: 's1',
      reason: 'picked by sender',
    });
    expect(routeDelivery(input({ sessions: [s1, w], threadOwner: 's1' }))).toMatchObject({
      sessionId: 's1',
      reason: 'owns thread',
    });
  });
  it('names the inactive chain owner it skipped', () => {
    const s1i = s({ id: 's1', active: false });
    const p = { parentOwner: 's1' };
    expect(routeDelivery(input({ sessions: [s1i, s2], ...p }))).toMatchObject({
      reason: 'longest-active session; skipped inactive s1 (owns parent thread)',
    });
    expect(routeDelivery(input({ sessions: [s1i, w], ...p }))).toMatchObject({
      reason: 'mesh window; skipped inactive s1 (owns parent thread)',
    });
    expect(routeDelivery(input({ sessions: [s1i], taskOwner: 's1' }))).toEqual({
      kind: 'wait',
      reason: 'no active push session; skipped inactive s1 (owns task)',
    });
  });

  const released = { bySession: 's9', closedAt: '2026-10-21T11:00:00Z', claudeSessionId: null };
  it("gives a closed private asker's thread to a 0.6.0 window, unclaimed and marked", () => {
    const w6 = { ...w, clientVersion: '0.6.0' };
    expect(routeDelivery(input({ sessions: [s1, w6], released }))).toEqual({
      kind: 'deliver',
      sessionId: 's2',
      claim: false,
      reason: 'released by closed s9',
      released,
    });
  });
  it('a 0.5.0 window, or no window, takes it as before', () => {
    expect(routeDelivery(input({ sessions: [s1, w], released }))).toStrictEqual(win);
    expect(routeDelivery(input({ released }))).toStrictEqual({
      kind: 'deliver',
      sessionId: 's1',
      claim: true,
      reason: 'longest-active session',
    });
  });
});

describe('chain owners that are inactive', () => {
  const off = s({ id: 's1', active: false });
  const fall = (why: string) => ({
    kind: 'deliver',
    sessionId: 's2',
    claim: true,
    reason: `longest-active session; skipped inactive s1 (${why})`,
  });
  it('an inactive parent owner does not hold the work', () => {
    expect(routeDelivery(input({ sessions: [off, s2], parentOwner: 's1' }))).toEqual(
      fall('owns parent thread'),
    );
  });
  it('an inactive task owner does not hold the work', () => {
    expect(routeDelivery(input({ sessions: [off, s2], taskOwner: 's1' }))).toEqual(
      fall('owns task'),
    );
  });
  it('an away parent owner still holds', () => {
    const away = s({ id: 's1', liveness: 'away' });
    const r = routeDelivery(input({ sessions: [away, s2], parentOwner: 's1' }));
    expect(r).toEqual({ kind: 'wait', reason: 'held for s1 (away)' });
  });
});
