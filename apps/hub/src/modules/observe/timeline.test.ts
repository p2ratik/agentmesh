import type { ObservedEvent } from '@agentmesh/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTimeline, type TimelineOptions } from './timeline';

const MSG = 'msg-01HZZZZZZZZZZZZZZZZZZZABCD';
let n = 0;
const ev = (over: Record<string, unknown>): ObservedEvent =>
  ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    at: '2026-10-16T10:40:05.000Z',
    receivedAt: '2026-10-16T10:40:05.000Z',
    session: null,
    source: 'plugin',
    agent: 'aheen-agent',
    ...over,
  }) as ObservedEvent;
const delivery = (source: string, stage: string, at: string, ms = 0, over = {}) =>
  ev({
    source,
    kind: 'delivery',
    message: MSG,
    thread: 'thr-31',
    stage,
    sinceReceivedMs: ms,
    at,
    receivedAt: at,
    ...over,
  });
const dropped = (at: string, over = {}) =>
  ev({ kind: 'dropped', count: 1, at, receivedAt: at, ...over });
const opts: TimelineOptions = { title: 'last 2h' };
const lines = (events: ObservedEvent[], o = opts) => formatTimeline(events, o).split('\n');

describe('formatTimeline', () => {
  beforeEach(() => vi.stubEnv('TZ', 'Asia/Kolkata'));
  afterEach(() => vi.unstubAllEnvs());

  it("folds a delivery's journey into one line", () => {
    const out = lines([
      delivery('hub', 'sent', '2026-10-16T10:40:05.000Z'),
      delivery('plugin', 'received', '2026-10-16T10:40:05.100Z'),
      delivery('plugin', 'pushed', '2026-10-16T10:40:05.500Z', 400),
    ]);
    expect(out).toEqual([
      'aheen-agent · plugin unknown · Claude Code unknown · unknown · last 2h · 2026-10-16 16:10–16:10 (UTC+05:30)',
      '16:10:05  delivery       thr-31 msg-…ABCD  hub sent → plugin got it → pushed to Claude ✓ 0.4s',
    ]);
  });

  it('says why an unfinished delivery stopped, in the same words as its steps', () => {
    const at = '2026-10-16T10:40:05.000Z';
    const end = (events: ObservedEvent[]) => lines(events)[1]?.replace(/^\S+ +delivery +/, '');
    expect(end([delivery('hub', 'sent', at)])).toBe('thr-31 msg-…ABCD  hub sent ✗ (not received)');
    expect(end([delivery('hub', 'sent', at), delivery('plugin', 'received', at)])).toBe(
      'thr-31 msg-…ABCD  hub sent → plugin got it ✗ (not pushed)',
    );
    expect(
      end([
        delivery('hub', 'sent', at),
        delivery('plugin', 'received', at),
        delivery('plugin', 'push_failed', at),
      ]),
    ).toBe('thr-31 msg-…ABCD  hub sent → plugin got it → push failed ✗ (push failed)');
    expect(end([delivery('hub', 'failed', at)])).toBe(
      'thr-31 msg-…ABCD  hub failed ✗ (hub failed)',
    );
    expect(end([delivery('hub', 'no_session', at)])).toBe(
      'thr-31 msg-…ABCD  hub found no session ✗ (no session)',
    );
  });

  it('shows a guard denial with its reason and key', () => {
    const out = lines([
      ev({
        source: 'guard',
        kind: 'guard',
        tool: 'send',
        decision: 'deny',
        reason: 'send.unknown_key',
        key: 'summary',
      }),
    ]);
    expect(out[1]).toMatch(/guard denied: send\.unknown_key \(summary\) ✗$/);
  });

  it("orders lines by each event's own time: a buffered disconnect prints first, sent late", () => {
    const s = { session: 's-ab12cd34ef56' };
    const hub = (phase: string, at: string) =>
      ev({ source: 'hub', kind: 'session', phase, at, receivedAt: at, ...s });
    const nats = (event: string, at: string) =>
      ev({ kind: 'nats', event, at, receivedAt: '2026-10-16T10:38:05.000Z', ...s });
    // As the hub stores them: in the order it received them.
    const out = lines([
      hub('opened', '2026-10-16T09:30:00.000Z'),
      hub('away', '2026-10-16T10:02:16.000Z'),
      hub('live', '2026-10-16T10:38:01.000Z'),
      nats('disconnect', '2026-10-16T10:01:00.000Z'),
      nats('reconnect', '2026-10-16T10:38:00.000Z'),
    ]);
    expect(out.slice(1)).toEqual([
      '15:00:00  session        opened',
      '15:31:00  nats           NATS disconnect (sent late, +37m)',
      '15:32:16  session        away',
      '16:08:00  nats           NATS reconnect',
      '16:08:01  session        live',
    ]);
  });

  it('marks the clock only when a time is impossible: after its receipt, or before its session', () => {
    const ahead = { receivedAt: '2026-10-16T10:40:05.000Z' };
    expect(lines([dropped('2026-10-16T10:45:05.000Z', ahead)])[1]).toMatch(
      /1 events dropped \(clock \+5m\)$/,
    );
    const s = { session: 's-ab12cd34ef56' };
    const out = lines([
      ev({ source: 'hub', kind: 'session', phase: 'opened', at: '2026-10-16T10:00:00.000Z', ...s }),
      ev({ kind: 'tool', tool: 'ask', outcome: 'ok', ms: 5, at: '2026-10-16T09:30:00.000Z', ...s }),
      ev({ kind: 'tool', tool: 'ask', outcome: 'ok', ms: 5, at: '2026-10-16T10:05:00.000Z', ...s }),
    ]);
    expect(out.slice(1)).toEqual([
      '15:00:00  tool           ask ok 5ms (clock -30m)',
      '15:30:00  session        opened',
      '15:35:00  tool           ask ok 5ms (sent late, +35m)',
    ]);
  });

  it('marks a folded delivery whose plugin events were sent late', () => {
    const late = { receivedAt: '2026-10-16T10:45:05.000Z' };
    const folded = lines([
      delivery('hub', 'sent', '2026-10-16T10:40:00.000Z'),
      delivery('plugin', 'received', '2026-10-16T10:40:01.000Z', 0, late),
    ]);
    expect(folded[1]).toMatch(/hub sent → plugin got it ✗ \(not pushed\) \(sent late, \+5m\)$/);
  });

  it("the header uses the latest connected event's versions", () => {
    const connected = (v: string, cc: string | null, at: string) =>
      ev({
        kind: 'connected',
        pluginVersion: v,
        claudeCodeVersion: cc,
        os: 'win32',
        arch: 'x64',
        node: '24.0.0',
        meshWindow: true,
        pull: false,
        at,
        receivedAt: at,
      });
    const out = lines([
      connected('0.6.0', '2.1.300', '2026-10-16T09:00:00.000Z'),
      connected('0.7.0', '2.1.319', '2026-10-16T10:00:00.000Z'),
    ]);
    expect(out[0]).toBe(
      'aheen-agent · plugin 0.7.0 · Claude Code 2.1.319 · win32 · last 2h · 2026-10-16 14:30–15:30 (UTC+05:30)',
    );
  });

  it('with several agents, lists versions per agent and prefixes each line', () => {
    const connected = ev({
      kind: 'connected',
      pluginVersion: '0.7.0',
      claudeCodeVersion: null,
      os: 'linux',
      arch: 'x64',
      node: '24',
      meshWindow: false,
      pull: false,
      agent: 'a-agent',
    });
    const out = lines([connected, dropped('2026-10-16T10:41:00.000Z', { agent: 'b-agent' })]);
    expect(out[0]).toBe('2 agents · last 2h · 2026-10-16 16:10–16:11 (UTC+05:30)');
    expect(out[1]).toBe('  a-agent: plugin 0.7.0 · Claude Code unknown · linux');
    expect(out[2]).toBe('  b-agent: plugin unknown · Claude Code unknown · unknown');
    expect(out[4]).toBe('16:11:00  dropped        b-agent 1 events dropped');
  });

  it('puts the date on the first line of each new day', () => {
    const out = lines([
      dropped('2026-11-05T18:00:00.000Z'),
      dropped('2026-11-05T19:00:00.000Z'),
      dropped('2026-11-05T19:30:00.000Z'),
    ]);
    expect(out[0]).toMatch(/2026-11-05 23:30–2026-11-06 01:00 \(UTC\+05:30\)$/);
    expect(out[1]).toMatch(/^23:30:00 /);
    expect(out[2]).toMatch(/^2026-11-06 00:30:00 /);
    expect(out[3]).toMatch(/^01:00:00 /);
  });

  it('uses the offset in force at each event, across a DST change', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const out = lines([dropped('2026-03-07T12:00:00.000Z'), dropped('2026-03-09T12:00:00.000Z')]);
    expect(out[1]).toMatch(/^07:00:00 /); // EST
    expect(out[2]).toMatch(/^2026-03-09 08:00:00 /); // EDT
  });

  it('says when the window was cut short, and when it is empty', () => {
    const out = lines([dropped('2026-10-16T10:40:05.000Z')], { ...opts, truncated: true });
    expect(out[1]).toBe(
      '(truncated: showing the newest 1 of more; narrow the window or raise limit)',
    );
    expect(lines([])).toEqual(['no events in this window']);
  });

  it('prefixes the session when events come from more than one', () => {
    const out = lines([
      dropped('2026-10-16T10:40:05.000Z', { session: 's-aaaaaaaaaaaa' }),
      dropped('2026-10-16T10:41:05.000Z', { session: 's-bbbbbbbbbbbb' }),
    ]);
    expect(out[1]).toMatch(/\[s-aaaaaaaaaaaa\] 1 events dropped$/);
    expect(out[2]).toMatch(/\[s-bbbbbbbbbbbb\] 1 events dropped$/);
    const one = lines([dropped('2026-10-16T10:40:05.000Z', { session: 's-aaaaaaaaaaaa' })]);
    expect(one[1]).not.toContain('[s-');
  });
});
