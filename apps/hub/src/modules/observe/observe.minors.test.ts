import { type ObservedEvent, RPC_METHODS } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { createBobDispatchHarness } from '../../testing/services';
import { fitTimeline, MAX_REPLY_BYTES } from './timeline';

type Harness = ReturnType<typeof createBobDispatchHarness>;
/** The stored delivery or relay stages, once the hub's queued events are written. */
const stages = (h: Harness, kind: 'delivery' | 'relay') => {
  h.ctx.events.flush();
  return h.ctx.db
    .all<{ body: string }>('SELECT body FROM events ORDER BY rowid')
    .map((r) => JSON.parse(r.body))
    .filter((e) => e.kind === kind)
    .map((e) => (e.code ? `${e.stage} ${e.code}` : e.stage));
};
const HOUR_MS = 3_600_000;

describe('a stuck message is recorded once a session an hour (M1)', () => {
  it('a session that never acks records sent and failed once per message and session an hour', async () => {
    const h = createBobDispatchHarness();
    const s = h.active();
    h.transport.respond.set(s, () => Promise.resolve([]));
    const m = h.ask(h.thread());
    for (let i = 0; i < 3; i++) await h.dispatcher.deliver('bob-agent', [m]);
    expect(stages(h, 'delivery')).toEqual(['sent', 'failed not_acked']);
    h.clock.advance(HOUR_MS);
    await h.dispatcher.deliver('bob-agent', [m]);
    expect(stages(h, 'delivery')).toEqual(['sent', 'failed not_acked', 'sent', 'failed not_acked']);
  });

  it('another session still records its own sent', async () => {
    const h = createBobDispatchHarness();
    const s = h.active();
    h.transport.respond.set(s, () => Promise.reject(new Error('gone')));
    const m = h.ask(h.thread());
    await h.dispatcher.deliver('bob-agent', [m]);
    h.active();
    await h.dispatcher.deliver('bob-agent', [m]);
    expect(stages(h, 'delivery')).toEqual(['sent', 'failed unreachable', 'sent', 'acked']);
  });

  it('a relay whose window never answers records sent once an hour', async () => {
    const h = createBobDispatchHarness();
    h.meshWindow();
    h.transport.relayAnswer = () => Promise.reject(new Error('timeout'));
    const p = h.sessions.open('bob-agent', { clientVersion: '0.6.0' }).session.id;
    const t = h.thread();
    h.sessions.take('bob-agent', p, t);
    h.reply(t);
    for (let i = 0; i < 3; i++) await h.outbox.flush();
    expect(h.transport.relays).toHaveLength(3);
    expect(stages(h, 'relay')).toEqual(['sent']);
    h.clock.advance(HOUR_MS);
    await h.outbox.flush();
    expect(stages(h, 'relay')).toEqual(['sent', 'sent']);
  });
});

describe('the timeline reply stays under NATS max_payload (M2)', () => {
  const guard = (i: number): ObservedEvent =>
    ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      at: new Date(Date.UTC(2026, 10, 6, 10, 0, i)).toISOString(),
      receivedAt: new Date(Date.UTC(2026, 10, 6, 10, 0, i)).toISOString(),
      session: null,
      source: 'guard',
      agent: 'alice-agent',
      kind: 'guard',
      tool: 'T'.repeat(64),
      decision: 'deny',
      reason: 'send.unknown_key',
      key: 'k'.repeat(40),
    }) as ObservedEvent;

  it('keeps the newest events that fit, and says it was cut short', () => {
    const events = Array.from({ length: 50 }, (_, i) => guard(i));
    const reply = fitTimeline(events, { title: 'last 2h', truncated: false }, 8000);
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(8000);
    expect(reply.truncated).toBe(true);
    expect(reply.events.length).toBeGreaterThan(0);
    expect(reply.events.length).toBeLessThan(50);
    expect(reply.events.at(-1)).toBe(events.at(-1));
    expect(reply.text).toContain(`(truncated: showing the newest ${reply.events.length} of more`);
  });

  it('leaves a reply that fits alone, and caps limit at 1000', () => {
    const events = Array.from({ length: 5 }, (_, i) => guard(i));
    const reply = fitTimeline(events, { title: 'last 2h', truncated: false });
    expect(reply).toMatchObject({ events, truncated: false });
    expect(MAX_REPLY_BYTES).toBe(700_000);
    const { params } = RPC_METHODS['observe.timeline'];
    expect(params.safeParse({ limit: 1000 }).success).toBe(true);
    expect(params.safeParse({ limit: 1001 }).success).toBe(false);
  });
});
