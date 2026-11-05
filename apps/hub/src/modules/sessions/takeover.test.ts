import { describe, expect, it, vi } from 'vitest';
import { threadKey } from '../../core/ids';
import { buildModules } from '../../runtime/modules';
import { createTestHarness } from '../../testing/harness';
import type { SessionsServiceImpl } from './sessions.service';
import { adoptAwayWindows } from './takeover';

function setup() {
  const h = createTestHarness();
  const { sessions, messaging } = buildModules(h.ctx, null, { kick: null }).services;
  const repo = (sessions as SessionsServiceImpl).repo;
  const open = (agent: string, meshWindow: boolean) =>
    sessions.open(agent, { clientVersion: '0.6.0', meshWindow }).session.id;
  const thread = () =>
    messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    }).id;
  const adopt = (id: string) => {
    const row = repo.get(id);
    if (!row) throw new Error('no row');
    return adoptAwayWindows(repo, row, h.clock.now().toISOString());
  };
  /** A window of `agent` that owns two threads and has gone away. */
  const awayWindow = (agent = 'alice-agent', meshWindow = true) => {
    const id = open(agent, meshWindow);
    const [t1, t2] = [thread(), thread()];
    sessions.take(agent, id, t1);
    sessions.take(agent, id, t2);
    sessions.unreachable(id);
    return { id, t1, t2 };
  };
  const liveness = (id: string) => repo.get(id)?.liveness;
  const orphanRows = () => h.ctx.db.all('SELECT * FROM orphan_decisions');
  return { ...h, sessions, repo, open, adopt, awayWindow, liveness, orphanRows };
}

describe('adoptAwayWindows', () => {
  it('closes the same agent s away window and moves its threads to the new one', () => {
    const h = setup();
    const w1 = h.awayWindow();
    const w2 = h.open('alice-agent', true);
    expect(h.adopt(w2)).toEqual({ closed: [w1.id], reclaimed: [w1.t1, w1.t2] });
    expect(h.liveness(w1.id)).toBe('closed');
    expect(h.sessions.ownerOf(w1.t1, 'alice-agent')).toBe(w2);
    expect(h.sessions.ownerOf(w1.t2, 'alice-agent')).toBe(w2);
  });

  it('leaves a live second window alone', () => {
    const h = setup();
    const w1 = h.awayWindow();
    h.sessions.touch('alice-agent', w1.id);
    const w2 = h.open('alice-agent', true);
    expect(h.adopt(w2)).toEqual({ closed: [], reclaimed: [] });
    expect(h.liveness(w1.id)).toBe('live');
    expect(h.sessions.ownerOf(w1.t1, 'alice-agent')).toBe(w1.id);
  });

  it('leaves an away private session alone', () => {
    const h = setup();
    const p = h.awayWindow('alice-agent', false);
    const w2 = h.open('alice-agent', true);
    expect(h.adopt(w2)).toEqual({ closed: [], reclaimed: [] });
    expect(h.liveness(p.id)).toBe('away');
    expect(h.sessions.ownerOf(p.t1, 'alice-agent')).toBe(p.id);
  });

  it('leaves another agent s away window alone', () => {
    const h = setup();
    const b = h.awayWindow('bob-agent');
    const w2 = h.open('alice-agent', true);
    expect(h.adopt(w2)).toEqual({ closed: [], reclaimed: [] });
    expect(h.liveness(b.id)).toBe('away');
  });

  it('does nothing for a session that is not a window', () => {
    const h = setup();
    const w1 = h.awayWindow();
    const p = h.open('alice-agent', false);
    expect(h.adopt(p)).toEqual({ closed: [], reclaimed: [] });
    expect(h.liveness(w1.id)).toBe('away');
  });

  it('records no orphan decision for the adopted threads', () => {
    const h = setup();
    h.awayWindow();
    h.adopt(h.open('alice-agent', true));
    expect(h.orphanRows()).toEqual([]);
  });
});

describe('activating a mesh window', () => {
  it('logs the replacement, and the old window re-hello reclaims nothing', () => {
    const h = setup();
    const info = vi.spyOn(h.ctx.logger, 'info');
    const w1 = h.awayWindow();
    const w2 = h.open('alice-agent', true);
    h.sessions.activate('alice-agent', w2, 'window');
    expect(info).toHaveBeenCalledWith(
      {
        agent: 'alice-agent',
        session: w2,
        replaced: [w1.id],
        reclaimed: [threadKey(w1.t1), threadKey(w1.t2)],
      },
      'away mesh window replaced',
    );
    expect(h.sessions.ownerOf(w1.t1, 'alice-agent')).toBe(w2);
    const again = h.sessions.open('alice-agent', {
      clientVersion: '0.6.0',
      meshWindow: true,
      previousSessionId: w1.id,
    });
    expect(again.session.id).not.toBe(w1.id);
    expect(again.reclaimed).toEqual([]);
    expect(h.sessions.ownerOf(w1.t1, 'alice-agent')).toBe(w2);
  });
});
