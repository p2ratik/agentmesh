import { MINUTE_MS } from '@agentmesh/common';
import { describe, expect, it, vi } from 'vitest';
import type { OpenInput } from '../../contracts';
import { createBobDispatchHarness } from '../../testing/services';
import type { SessionsServiceImpl } from './sessions.service';

const UUID = '0b6c1a52-3e9f-4d2a-9c11-5f2e8a7d4b10';
const FORK = '7d1e0c3a-2b4f-4e6a-8c9d-1a2b3c4d5e6f';

/** Bob's harness, with `p`: a session of conversation UUID that owns thread `t`. */
function setup() {
  const h = createBobDispatchHarness();
  const { repo } = h.sessions as SessionsServiceImpl;
  const open = (input: Partial<OpenInput> = {}, agent = 'bob-agent') =>
    h.sessions.open(agent, { clientVersion: '0.6.0', ...input });
  const p = open({ claudeSessionId: UUID }).session.id;
  const t = h.thread();
  h.sessions.take('bob-agent', p, t);
  return { ...h, repo, open, p, t };
}

describe('resuming a conversation', () => {
  it("a new session with a closed session's Claude id takes back its unowned threads, once", () => {
    const h = setup();
    h.sessions.close('bob-agent', h.p);
    const n = h.open({ claudeSessionId: UUID });
    expect(n.reclaimed).toEqual([h.t]);
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBe(n.session.id);
    const scan = vi.spyOn(h.repo, 'resumable');
    const again = h.open({ previousSessionId: n.session.id, claudeSessionId: UUID });
    expect(again).toMatchObject({ session: { id: n.session.id }, reclaimed: [] });
    expect(scan).not.toHaveBeenCalled();
  });

  it('takes over an away session with the same id: it closes it first', () => {
    const h = setup();
    h.sessions.unreachable(h.p);
    expect(h.liveness(h.p)).toBe('away');
    const n = h.open({ claudeSessionId: UUID });
    expect(n.reclaimed).toEqual([h.t]);
    expect(h.repo.get(h.p)?.liveness).toBe('closed');
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBe(n.session.id);
  });

  it('learns the id on a later hello of the same session', () => {
    const h = setup();
    h.sessions.close('bob-agent', h.p);
    const n = h.open();
    expect(n.reclaimed).toEqual([]);
    const later = h.open({ previousSessionId: n.session.id, claudeSessionId: UUID });
    expect(later).toMatchObject({ session: { id: n.session.id }, reclaimed: [h.t] });
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBe(n.session.id);
  });

  it("ignores live sessions, another agent's sessions, and a fork's new id", () => {
    const live = setup();
    expect(live.open({ claudeSessionId: UUID }).reclaimed).toEqual([]);
    expect(live.sessions.ownerOf(live.t, 'bob-agent')).toBe(live.p);

    const other = setup();
    const a = other.open({ claudeSessionId: UUID }, 'alice-agent').session.id;
    other.sessions.take('alice-agent', a, other.t);
    other.sessions.close('alice-agent', a);
    other.sessions.close('bob-agent', other.p);
    expect(other.open({ claudeSessionId: FORK }).reclaimed).toEqual([]);
    const b = other.open({ claudeSessionId: UUID }).reclaimed;
    expect(b).toEqual([other.t]);
    expect(other.sessions.ownerOf(other.t, 'alice-agent')).toBeNull();

    const fork = setup();
    fork.sessions.close('bob-agent', fork.p);
    expect(fork.open({ claudeSessionId: FORK }).reclaimed).toEqual([]);
    expect(fork.sessions.ownerOf(fork.t, 'bob-agent')).toBeNull();
  });

  it("deletes the reclaimed threads' orphan rows, so nothing escalates", async () => {
    const h = setup();
    h.meshWindow();
    h.sessions.close('bob-agent', h.p);
    h.reply(h.t);
    await h.outbox.flush();
    const rows = () => h.ctx.db.all('SELECT thread_id FROM orphan_decisions');
    expect(rows()).toEqual([{ thread_id: h.t }]);
    expect(h.open({ claudeSessionId: UUID }).reclaimed).toEqual([h.t]);
    expect(rows()).toEqual([]);
    h.clock.advance(15 * MINUTE_MS);
    expect(h.orphans.tick(h.clock.now())).toBe(0);
  });

  // Task 8: whoever takes a thread after the close leaves the closed session's release list.
  it('reclaims only threads nobody owned since the close', () => {
    const h = setup();
    const w = h.meshWindow();
    const t2 = h.thread();
    h.sessions.take('bob-agent', h.p, t2);
    h.sessions.close('bob-agent', h.p);
    h.sessions.take('bob-agent', w, h.t);
    const n = h.open({ claudeSessionId: UUID });
    expect(n.reclaimed).toEqual([t2]);
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBe(w);
    expect(h.sessions.ownerOf(t2, 'bob-agent')).toBe(n.session.id);
  });
});

describe('take', () => {
  it("commits the owner and the closed sessions' release lists together", () => {
    const h = setup();
    h.sessions.close('bob-agent', h.p);
    const w = h.meshWindow();
    const run = h.ctx.db.run.bind(h.ctx.db);
    vi.spyOn(h.ctx.db, 'run').mockImplementation((sql, params) => {
      if (sql.includes('SET released')) throw new Error('disk full');
      return run(sql, params);
    });
    expect(() => h.sessions.take('bob-agent', w, h.t)).toThrow('disk full');
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBeNull();
  });
});
