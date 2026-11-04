import { MINUTE_MS } from '@agentmesh/common';
import { ConfigIndex } from '@agentmesh/config';
import { describe, expect, it, vi } from 'vitest';
import { leaveTeam } from '../../testing/harness';
import { createBobDispatchHarness } from '../../testing/services';
import type { SessionsServiceImpl } from './sessions.service';

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
    h.ctx.db.all(
      'SELECT thread_id, agent_id, released_by, due_at, escalated_at FROM orphan_decisions',
    );
  const messagesIn = (threadId: number) =>
    h.ctx.db.all<{
      kind: string;
      body: string;
      status: string | null;
      recipients: string;
      status_for: string;
    }>(
      `SELECT kind, body, status, recipients, status_for FROM messages
       WHERE thread_id = $threadId ORDER BY seq`,
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
      { thread_id: h.t, agent_id: 'bob-agent', released_by: h.p, due_at: due, escalated_at: null },
    ]);
    const notices = h.messagesIn(h.t).filter((m) => m.body.includes("Bob's decision"));
    expect(notices.map(({ kind, body }) => ({ kind, body }))).toEqual([
      { kind: 'system', body: NOTICE },
    ]);
    // Status for both participants: it wakes neither agent.
    const both = JSON.stringify(['alice-agent', 'bob-agent']);
    expect(notices.map((m) => [m.recipients, m.status_for])).toEqual([[both, both]]);
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
      status_for: '[]',
      body:
        "The session that asked this has closed, and its answer has waited 15 minutes for Bob's " +
        'decision: continue it in the mesh window, reopen that session, or drop it. Reply here or ' +
        'in the mesh window.',
    });
    expect(h.rows()).toMatchObject([{ escalated_at: h.clock.now().toISOString() }]);
    expect(h.tick(15)).toBe(0);
  });

  // Controller ruling: one notice and one escalation per closed asker.
  it('after the escalation, another teammate reply gets no second notice or escalation', async () => {
    const h = setup();
    await h.orphan();
    expect(h.tick(15)).toBe(1);
    h.reply(h.t);
    await h.outbox.flush();
    expect(h.sentTo(h.w).filter((m) => m.kind === 'reply')).toHaveLength(2);
    expect(h.tick(15)).toBe(0);
    const kinds = h.messagesIn(h.t).map((m) => m.kind);
    expect(kinds).toEqual(['reply', 'system', 'escalation', 'reply']);
  });

  it("the owner's own reply in a released thread starts no timer and posts no notice", async () => {
    const h = setup();
    h.sessions.close('bob-agent', h.p);
    const post = { threadId: h.t, senderId: 'bob', kind: 'reply' as const, body: 'drop it' };
    const decision = h.messaging.post(post).message;
    expect(decision.refs.decidesFor).toEqual(['bob-agent']);
    await h.outbox.flush();
    expect(h.sentTo(h.w).map((m) => m.id)).toContain(decision.id);
    expect(h.rows()).toEqual([]);
    expect(h.messagesIn(h.t).map((m) => m.kind)).toEqual(['reply']);
  });

  it("the owner's answer after the notice settles the timer: no ping", async () => {
    const h = setup();
    await h.orphan();
    h.clock.advance(5 * MINUTE_MS);
    h.messaging.post({ threadId: h.t, senderId: 'bob', kind: 'reply', body: 'drop it' });
    await h.outbox.flush();
    expect(h.rows()).toMatchObject([{ escalated_at: h.clock.now().toISOString() }]);
    expect(h.tick(15)).toBe(0);
    expect(h.messagesIn(h.t).map((m) => m.kind)).toEqual(['reply', 'system', 'reply']);
  });

  // Review (Important): a thread someone took since the close is no longer that asker's.
  it('a thread taken and released again since the close routes as plain work', async () => {
    const h = setup();
    await h.orphan();
    const a = h.active();
    h.sessions.take('bob-agent', a, h.t);
    expect(h.tick(15)).toBe(0);
    h.sessions.deactivate('bob-agent', a);
    const r = h.reply(h.t);
    const plain = { kind: 'deliver', sessionId: h.w, claim: true, reason: 'mesh window' };
    expect(h.sessions.route('bob-agent', r)).toStrictEqual(plain);
    await h.outbox.flush();
    expect(h.rows()).toEqual([]);
    expect(h.messagesIn(h.t).filter((m) => m.kind === 'system')).toHaveLength(1);
  });

  it('no notice when the window took the thread between the send and the commit', async () => {
    const h = setup();
    h.sessions.close('bob-agent', h.p);
    h.transport.respond.set(h.w, async (messages) => {
      h.sessions.take('bob-agent', h.w, h.t);
      return messages.map((m) => m.id);
    });
    h.reply(h.t);
    await h.outbox.flush();
    expect(h.sessions.ownerOf(h.t, 'bob-agent')).toBe(h.w);
    expect(h.rows()).toEqual([]);
    expect(h.messagesIn(h.t).map((m) => m.kind)).toEqual(['reply']);
  });

  it('an agent that left the team: its row is settled and nobody is pinged', async () => {
    const h = setup();
    await h.orphan();
    leaveTeam(h.ctx, 'bob');
    expect(h.tick(15)).toBe(0);
    expect(h.rows()).toMatchObject([{ escalated_at: h.clock.now().toISOString() }]);
    expect(h.messagesIn(h.t).map((m) => m.kind)).not.toContain('escalation');
  });

  it('warns when the owner has no Discord account, and still escalates', async () => {
    const h = setup();
    await h.orphan();
    const { config } = h.ctx.index;
    const humans = config.humans.map(({ discordUserId: _, ...human }) => human);
    h.ctx.setIndex(new ConfigIndex({ ...config, humans }));
    const warn = vi.spyOn(h.ctx.logger, 'warn');
    expect(h.tick(15)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      { agent: 'bob-agent', owner: 'bob', thread: `thr-${h.t}` },
      'closed-asker escalation pings nobody: no Discord account mapped',
    );
  });

  it('a row that fails is logged, and the rows due after it still escalate', async () => {
    const h = setup();
    await h.orphan();
    h.ctx.db.run(
      `INSERT INTO orphan_decisions (thread_id, agent_id, released_by, due_at)
       VALUES (999, 'bob-agent', 's-000000000000', '2026-01-01T00:00:00.000Z')`,
    );
    const error = vi.spyOn(h.ctx.logger, 'error');
    expect(h.tick(15)).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ thread: 'thr-999', agent: 'bob-agent' }),
      expect.any(String),
    );
  });

  it('effectiveOwner skips the release scan; routing a delivery runs it', () => {
    const h = setup();
    const scan = vi.spyOn((h.sessions as SessionsServiceImpl).repo, 'releasedBy');
    h.sessions.close('bob-agent', h.p);
    h.sessions.effectiveOwner(h.t, 'bob-agent');
    expect(scan).not.toHaveBeenCalled();
    h.sessions.route('bob-agent', h.reply(h.t));
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('drops the row when the window took the thread or the thread closed, escalated or not', async () => {
    const settles = [
      (h: Setup) => h.sessions.take('bob-agent', h.w, h.t),
      (h: Setup) => h.messaging.closeThread(h.t, 'alice'),
    ];
    for (const escalated of [false, true]) {
      for (const settle of settles) {
        const h = setup();
        await h.orphan();
        if (escalated) expect(h.tick(15)).toBe(1);
        settle(h);
        expect(h.tick(15)).toBe(0);
        expect(h.rows()).toEqual([]);
        const escalations = h.messagesIn(h.t).filter((m) => m.kind === 'escalation');
        expect(escalations).toHaveLength(escalated ? 1 : 0);
      }
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
