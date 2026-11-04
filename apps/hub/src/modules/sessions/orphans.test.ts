import { MINUTE_MS } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import { createBobDispatchHarness } from '../../testing/services';

const NOTICE = "The session that asked this has closed; the follow-up waits for Bob's decision.";

/** Bob's mesh window `w` at `version`, and a private session `p` (opened, never activated) owning `t`. */
function setup(version = '0.6.0') {
  const h = createBobDispatchHarness();
  const w = h.meshWindow(version);
  const p = h.sessions.open('bob-agent', { clientVersion: '0.6.0' }).session.id;
  const t = h.thread();
  h.sessions.take('bob-agent', p, t);
  /** Every message sent to a session, carried status items included. */
  const sentTo = (sessionId: string) =>
    h.transport.batches.filter((_, i) => h.transport.sends[i]?.sessionId === sessionId).flat();
  const rows = () =>
    h.ctx.db.all('SELECT thread_id, agent_id, released_by, due_at FROM orphan_decisions');
  const messagesIn = (threadId: number) =>
    h.ctx.db.all<{ kind: string; body: string; status: string | null; recipients: string }>(
      'SELECT kind, body, status, recipients FROM messages WHERE thread_id = $threadId ORDER BY seq',
      { threadId },
    );
  /** Advances the clock, then runs the hub's tick. */
  const tick = (minutes: number) => {
    h.clock.advance(minutes * MINUTE_MS);
    return h.orphans.tick(h.clock.now());
  };
  /** Closes `p` and flushes one teammate reply in `t` to the window. */
  const orphan = async () => {
    h.sessions.close('bob-agent', p);
    h.reply(t);
    await h.outbox.flush();
  };
  return { ...h, w, p, t, sentTo, rows, messagesIn, tick, orphan };
}
type Setup = ReturnType<typeof setup>;

describe('a closed private asker', () => {
  it('routes the answer to the window unclaimed, with the notice and the timer once', async () => {
    const h = setup();
    h.sessions.close('bob-agent', h.p);
    const closedAt = h.clock.now().toISOString();
    const [r1, r2] = [h.reply(h.t), h.reply(h.t)];
    await h.outbox.flush();
    const answers = h.sentTo(h.w).filter((m) => m.id === r1.id || m.id === r2.id);
    const released = { bySession: h.p, closedAt, claudeSessionId: null };
    expect(answers.map((m) => [m.id, m.released])).toEqual([
      [r1.id, released],
      [r2.id, released],
    ]);
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBeNull();
    const due = new Date(h.clock.now().getTime() + 15 * MINUTE_MS).toISOString();
    expect(h.rows()).toEqual([
      { thread_id: h.t, agent_id: 'bob-agent', released_by: h.p, due_at: due },
    ]);
    const notices = h.messagesIn(h.t).filter((m) => m.body.includes("Bob's decision"));
    expect(notices.map(({ kind, body }) => ({ kind, body }))).toEqual([
      { kind: 'system', body: NOTICE },
    ]);
  });

  it('escalates in the thread to the owner after the configured minutes, once', async () => {
    const h = setup();
    await h.orphan();
    expect(h.tick(14)).toBe(0);
    expect(h.tick(1)).toBe(1);
    expect(h.messagesIn(h.t).at(-1)).toEqual({
      kind: 'escalation',
      status: 'needs_human',
      recipients: '["bob"]',
      body:
        "The session that asked this has closed, and its answer has waited 15 minutes for Bob's " +
        'decision: continue it in the mesh window, reopen that session, or drop it. Reply here or ' +
        'in the mesh window.',
    });
    expect(h.rows()).toEqual([]);
    expect(h.tick(15)).toBe(0);
  });

  it('drops the timer when the window took the thread or the thread closed', async () => {
    const settles = [
      (h: Setup) => h.sessions.take('bob-agent', h.w, h.t),
      (h: Setup) => h.messaging.closeThread(h.t, 'alice'),
    ];
    for (const settle of settles) {
      const h = setup();
      await h.orphan();
      settle(h);
      expect(h.tick(15)).toBe(0);
      expect(h.rows()).toEqual([]);
      expect(h.messagesIn(h.t).map((m) => m.kind)).not.toContain('escalation');
    }
  });

  // Review focus 4: only a private asker's close starts any of this.
  it('a window restart and an activated session release threads as today', async () => {
    const h = setup();
    const a = h.active();
    const tw = h.messaging.createThread({
      kind: 'task',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    }).id;
    const ta = h.thread();
    h.sessions.take('bob-agent', h.w, tw);
    h.sessions.take('bob-agent', a, ta);
    h.sessions.close('bob-agent', h.w);
    h.sessions.close('bob-agent', a);
    const w2 = h.meshWindow();
    for (const r of [h.reply(tw), h.reply(ta)]) {
      expect(h.sessions.route('bob-agent', r)).toStrictEqual({
        kind: 'deliver',
        sessionId: w2,
        claim: true,
        reason: 'mesh window',
      });
    }
    await h.outbox.flush();
    expect([tw, ta].map((t) => h.sessions.ownerOf(t, 'bob-agent'))).toEqual([w2, w2]);
    expect(h.rows()).toEqual([]);
    expect([tw, ta].flatMap((t) => h.messagesIn(t)).map((m) => m.kind)).toEqual(['reply', 'reply']);
  });

  // Review focus 1: a window before 0.6.0 behaves exactly as today.
  it("a 0.5.0 window gets the closed asker's reply as today", async () => {
    const h = setup('0.5.0');
    await h.orphan();
    const sent = h.sentTo(h.w).filter((m) => m.kind === 'reply');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('released');
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBe(h.w);
    expect(h.rows()).toEqual([]);
  });
});
