import { describe, expect, it } from 'vitest';
import { buildModules } from '../../runtime/modules';
import { testTeamConfig } from '../../testing/fixtures';
import { createTestHarness } from '../../testing/harness';
import { createBobDispatchHarness } from '../../testing/services';

function setup() {
  const h = createTestHarness();
  const { sessions, messaging } = buildModules(h.ctx, null, { kick: null }).services;
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

  it('records whether a session was private when it closed', () => {
    const { ctx, sessions, s1 } = setup();
    const open = (meshWindow: boolean) =>
      sessions.open('alice-agent', { clientVersion: '0.6.0', meshWindow }).session.id;
    const [inactive, win] = [open(false), open(true)];
    for (const id of [inactive, s1, win]) sessions.close('alice-agent', id);
    const privateAtClose = (id: string) =>
      ctx.db.get<{ p: number }>('SELECT private_at_close AS p FROM sessions WHERE id = $id', { id })
        ?.p;
    expect([inactive, s1, win].map(privateAtClose)).toEqual([1, 0, 0]);
  });
});

describe('session limits', () => {
  function capped(max: number) {
    const h = createTestHarness(testTeamConfig({ limits: { maxSessionsPerAgent: max } }));
    const { sessions } = buildModules(h.ctx, null, { kick: null }).services;
    const open = (previousSessionId?: string) =>
      sessions.open('alice-agent', { clientVersion: '0.4.0', previousSessionId }).session.id;
    const openIds = () =>
      h.ctx.db
        .all<{ id: string }>(
          "SELECT id FROM sessions WHERE agent_id = 'alice-agent' AND liveness <> 'closed'",
        )
        .map((r) => r.id)
        .sort();
    return { ...h, sessions, open, openIds };
  }

  it('a new session beyond the cap closes the stalest one, away before live', () => {
    const { clock, sessions, open, openIds } = capped(3);
    const s1 = open();
    clock.advance(1000);
    const s2 = open();
    clock.advance(1000);
    const s3 = open();
    sessions.unreachable(s2);
    clock.advance(1000);
    const s4 = open();
    expect(openIds()).toEqual([s1, s3, s4].sort());
    clock.advance(1000);
    sessions.touch('alice-agent', s1);
    const s5 = open();
    expect(openIds()).toEqual([s1, s4, s5].sort());
  });

  it('a reconnect keeps its open session and closes nothing', () => {
    const { open, openIds } = capped(2);
    const s1 = open();
    const s2 = open();
    expect(open(s1)).toBe(s1);
    expect(openIds()).toEqual([s1, s2].sort());
  });

  // Final review M3: an evicted session may still be open, so it is not a closed asker.
  it('an evicted live private session records no private_at_close, and no orphan decision follows', async () => {
    const h = createBobDispatchHarness();
    h.ctx.loaded.config.limits.maxSessionsPerAgent = 2;
    const p = h.sessions.open('bob-agent', { clientVersion: '0.6.0' }).session.id;
    const t = h.thread();
    h.sessions.take('bob-agent', p, t);
    h.clock.advance(1000);
    h.meshWindow();
    h.sessions.open('bob-agent', { clientVersion: '0.6.0' });
    expect(
      h.ctx.db.get('SELECT liveness, private_at_close FROM sessions WHERE id = $p', { p }),
    ).toEqual({ liveness: 'closed', private_at_close: 0 });
    h.reply(t);
    await h.outbox.flush();
    expect(h.ctx.db.all('SELECT thread_id FROM orphan_decisions')).toEqual([]);
  });

  it('deletes sessions closed more than 30 days ago', () => {
    const { clock, ctx, sessions, open } = capped(5);
    const old = open();
    sessions.close('alice-agent', old);
    clock.advance(29 * 24 * 60 * 60_000);
    const recent = open();
    sessions.close('alice-agent', recent);
    clock.advance(2 * 24 * 60 * 60_000);
    sessions.expire(clock.now());
    const ids = ctx.db.all<{ id: string }>('SELECT id FROM sessions').map((r) => r.id);
    expect(ids).toEqual([recent]);
  });
});

describe('away sessions in the active list', () => {
  it('labels an away session with when it went away and when it closes, from config', () => {
    const { ctx, clock, sessions } = setup();
    ctx.loaded.config.presence.ownershipGraceMinutes = 30;
    expect(sessions.activeSessions('alice-agent')[0]).toMatchObject({
      liveness: 'live',
      awaySince: null,
      closesAt: null,
    });
    clock.advance(76_000);
    sessions.expire(clock.now());
    const away = clock.now().toISOString();
    expect(sessions.activeSessions('alice-agent')[0]).toMatchObject({
      liveness: 'away',
      awaySince: away,
      closesAt: new Date(clock.now().getTime() + 30 * 60_000).toISOString(),
    });
  });
});
