import { describe, expect, it } from 'vitest';
import { buildModules } from '../../runtime/modules';
import { createTestHarness } from '../../testing/harness';

function setup() {
  const h = createTestHarness();
  const { sessions, messaging } = buildModules(h.ctx, null, { inboxes: null, kick: null }).services;
  const s1 = sessions.open('alice-agent', { clientVersion: '0.2.0' }).session.id;
  const thread = messaging.createThread({
    kind: 'conversation',
    subject: 'x',
    createdBy: 'alice-agent',
    participants: ['bob-agent'],
  }).id;
  sessions.activate('alice-agent', s1, 'working');
  sessions.take('alice-agent', s1, thread);
  const liveness = () =>
    h.ctx.db.get<{ liveness: string }>('SELECT liveness FROM sessions WHERE id = $id', { id: s1 })
      ?.liveness;
  return { ...h, sessions, s1, thread, liveness };
}

describe('session liveness', () => {
  it('a silent session goes away but keeps its work', () => {
    const { clock, sessions, s1, thread, liveness } = setup();
    clock.advance(76_000);
    expect(sessions.expire(clock.now())).toEqual({ away: 1, closed: 0 });
    expect(liveness()).toBe('away');
    expect(sessions.ownerOf(thread, 'alice-agent')).toBe(s1);
  });

  it('a heartbeat brings an away session back with its work', () => {
    const { clock, sessions, s1, thread, liveness } = setup();
    clock.advance(76_000);
    sessions.expire(clock.now());
    expect(sessions.touch('alice-agent', s1, { branch: 'feat' })).toBe('ok');
    expect(liveness()).toBe('live');
    expect(sessions.verify('alice-agent', s1)).toMatchObject({ active: true, branch: 'feat' });
    expect(sessions.ownerOf(thread, 'alice-agent')).toBe(s1);
  });

  it('after the grace period the session closes and releases its work', () => {
    const { clock, sessions, s1, thread, liveness } = setup();
    clock.advance(76_000);
    sessions.expire(clock.now());
    clock.advance(121 * 60_000);
    expect(sessions.expire(clock.now())).toEqual({ away: 0, closed: 1 });
    expect(liveness()).toBe('closed');
    expect(sessions.ownerOf(thread, 'alice-agent')).toBeNull();
    const again = sessions.open('alice-agent', { clientVersion: '0.2.0', previousSessionId: s1 });
    expect(again.reclaimed).toEqual([thread]);
  });

  it('touch reports unknown for a closed or foreign session', () => {
    const { sessions, s1 } = setup();
    expect(sessions.touch('bob-agent', s1)).toBe('unknown');
    expect(sessions.touch('alice-agent', 'ses_nope')).toBe('unknown');
    sessions.close('alice-agent', s1);
    expect(sessions.touch('alice-agent', s1)).toBe('unknown');
  });

  it('unreachable marks away immediately', () => {
    const { sessions, s1, liveness } = setup();
    sessions.unreachable(s1);
    expect(liveness()).toBe('away');
  });
});
