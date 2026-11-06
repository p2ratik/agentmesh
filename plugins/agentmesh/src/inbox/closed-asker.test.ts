import type { ReleasedMarker, SessionDelivery } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { closedAskerNotice } from './closed-asker';
import { renderEvent } from './render';
import { harness, message } from './session-inbox.fixture';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const marker = (bySession: string, claudeSessionId: string | null = UUID): ReleasedMarker => ({
  bySession,
  closedAt: '2026-11-04T09:30:00.000Z',
  claudeSessionId,
});
const released = (id: string, bySession = 's-bbbbbbbbbbbb'): SessionDelivery => ({
  ...message(id, 'thr-7'),
  kind: 'reply',
  released: marker(bySession),
});
/** The owner answering from Discord: the hub marks it for alice-agent, and still releases it. */
const ownerReply = (id: string): SessionDelivery => ({
  ...released(id),
  from: { id: 'alice', kind: 'human', displayName: 'Alice' },
  refs: { decidesFor: ['alice-agent'] },
});

describe('closedAskerNotice', () => {
  it('asks the human to continue, reopen or drop, in exactly these lines', () => {
    expect(closedAskerNotice('thr-7', marker('s-bbbbbbbbbbbb'), 15).split('\n')).toEqual([
      "AgentMesh: the session that asked this (s-bbbbbbbbbbbb) has closed. Don't act on this answer: ask your human which they want.",
      '- Continue it here: take(thread_id: "thr-7"), say in one line in the thread that your human continues it here, then work on it in a fresh worktree.',
      `- Reopen that session: they run claude --resume ${UUID} in that project's folder, and the thread goes back to it.`,
      '- Drop it: take(thread_id: "thr-7") and say in one line in the thread that your human dropped it.',
      "If they don't answer within 15 minutes, the hub pings them on Discord.",
    ]);
  });

  it('says a session without a conversation id cannot be reopened', () => {
    expect(closedAskerNotice('thr-7', marker('s-bbbbbbbbbbbb', null), 30).split('\n')).toEqual([
      "AgentMesh: the session that asked this (s-bbbbbbbbbbbb) has closed. Don't act on this answer: ask your human which they want.",
      '- Continue it here: take(thread_id: "thr-7"), say in one line in the thread that your human continues it here, then work on it in a fresh worktree.',
      '- Reopen that session: not possible, its conversation id is unknown.',
      '- Drop it: take(thread_id: "thr-7") and say in one line in the thread that your human dropped it.',
      "If they don't answer within 30 minutes, the hub pings them on Discord.",
    ]);
  });
});

describe('renderEvent with a notice', () => {
  it('puts the notice after the body, clipped or not, and before the FYI footer', () => {
    const notice = 'AgentMesh: notice';
    const footer = 'FYI (1):\n· thr-1 «Deploy» done';
    expect(renderEvent([message('m1', 'thr-7')], { notice, footer }).content).toBe(
      `│ body m1\n\n${notice}\n\n${footer}`,
    );
    const long = { ...message('m1', 'thr-7'), body: 'x'.repeat(500) };
    expect(renderEvent([long], { notice, maxChars: 100 }).content.endsWith(`)\n\n${notice}`)).toBe(
      true,
    );
  });

  it('marks asker="closed" when any message in the bundle was released, and only then', () => {
    expect(renderEvent([released('m1')]).meta.asker).toBe('closed');
    expect(renderEvent([released('m1'), message('m2', 'thr-7')]).meta.asker).toBe('closed');
    expect(renderEvent([message('m1', 'thr-7')]).meta.asker).toBeUndefined();
    expect(renderEvent([ownerReply('m1')], { selfId: 'alice-agent' }).meta.asker).toBeUndefined();
  });
});

describe('a closed asker in the session inbox', () => {
  it("pushes the thread with asker=closed and the notice of its last released message, with the hello's minutes", async () => {
    const h = harness(undefined, { closedAskerMinutes: () => 20 });
    const messages = [released('a1'), message('a2', 'thr-7'), released('a3', 's-cccccccccccc')];
    const ack = await h.send({ type: 'deliver', messages }).acked;
    expect(ack.delivered).toEqual(['a1', 'a2', 'a3']);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.meta.asker).toBe('closed');
    expect(h.pushed[0]?.content).toContain('within 20 minutes');
    expect(h.pushed[0]?.content).toContain('(s-cccccccccccc) has closed');
    expect(h.pushed[0]?.content).not.toContain('s-bbbbbbbbbbbb');
  });

  it('pushes an ordinary thread without a notice', async () => {
    const h = harness(undefined, { closedAskerMinutes: () => 20 });
    await h.send({ type: 'deliver', messages: [message('a1', 'thr-7')] }).acked;
    expect(h.pushed[0]?.content).toBe('│ body a1');
    expect(h.pushed[0]?.meta.asker).toBeUndefined();
  });

  it("pushes the owner's own reply as the decision it is: no notice, no asker", async () => {
    const h = harness();
    await h.send({ type: 'deliver', messages: [ownerReply('a1')] }).acked;
    expect(h.pushed[0]?.meta.decides).toBe('yes');
    expect(h.pushed[0]?.meta.asker).toBeUndefined();
    expect(h.pushed[0]?.content).toBe('│ body a1');
    // Beside a teammate's answer, the push is no longer the owner's alone: the notice stays.
    await h.send({ type: 'deliver', messages: [ownerReply('a2'), released('a3')] }).acked;
    expect(h.pushed[1]?.meta.decides).toBeUndefined();
    expect(h.pushed[1]?.meta.asker).toBe('closed');
    expect(h.pushed[1]?.content).toContain("Don't act on this answer: ask your human");
  });

  it("keeps the hub's own notice post (status class, released) in the FYI buffer: no push", async () => {
    const h = harness();
    const post: SessionDelivery = {
      ...released('n1'),
      kind: 'system',
      class: 'status',
      from: { id: 'agentmesh-hub', kind: 'service', displayName: 'AgentMesh' },
      body: "The session that asked this has closed; the follow-up waits for Alice's decision.",
    };
    const ack = await h.send({ type: 'deliver', messages: [post] }).acked;
    expect(ack.delivered).toEqual(['n1']);
    expect(h.pushed).toEqual([]);
    expect(h.fyi.take().items.map((m) => m.id)).toEqual(['n1']);
  });
});
