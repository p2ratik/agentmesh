import type { ObservedEvent } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { formatTimeline } from './timeline';

const now = new Date('2026-10-16T12:00:00.000Z');
const hms = (iso: string) =>
  new Date(new Date(iso).getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(11, 19);
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
const delivery = (source: string, stage: string, at: string, ms = 0) =>
  ev({
    source,
    kind: 'delivery',
    message: MSG,
    thread: 'thr-31',
    stage,
    sinceReceivedMs: ms,
    at,
    receivedAt: at,
  });
const opts = { title: 'last 2h', now };

describe('formatTimeline', () => {
  it("folds a delivery's journey into one line", () => {
    const text = formatTimeline(
      [
        delivery('hub', 'sent', '2026-10-16T10:40:05.000Z'),
        delivery('plugin', 'received', '2026-10-16T10:40:05.100Z'),
        delivery('plugin', 'pushed', '2026-10-16T10:40:05.500Z', 400),
      ],
      opts,
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      `${hms('2026-10-16T10:40:05.000Z')}  delivery       thr-31 msg-…ABCD  hub sent → plugin got it → pushed to Claude ✓ 0.4s`,
    );
  });

  it('a delivery that was received but never pushed ends ✗ (received)', () => {
    const text = formatTimeline(
      [
        delivery('hub', 'sent', '2026-10-16T10:40:05.000Z'),
        delivery('plugin', 'received', '2026-10-16T10:40:06.000Z'),
      ],
      opts,
    );
    expect(text.split('\n')[1]).toMatch(/hub sent → plugin got it ✗ \(received\)$/);
  });

  it('shows a guard denial with its reason and key', () => {
    const text = formatTimeline(
      [
        ev({
          source: 'guard',
          kind: 'guard',
          tool: 'send',
          decision: 'deny',
          reason: 'send.unknown_key',
          key: 'summary',
        }),
      ],
      opts,
    );
    expect(text.split('\n')[1]).toMatch(/guard denied: send\.unknown_key \(summary\) ✗$/);
  });

  it('marks a skewed plugin clock', () => {
    const text = formatTimeline(
      [
        ev({
          kind: 'dropped',
          count: 3,
          at: '2026-10-16T10:35:05.000Z',
          receivedAt: '2026-10-16T10:40:05.000Z',
        }),
      ],
      opts,
    );
    expect(text.split('\n')[1]).toMatch(/3 events dropped \(clock \+5m\)$/);
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
    const text = formatTimeline(
      [
        connected('0.6.0', '2.1.300', '2026-10-16T09:00:00.000Z'),
        connected('0.7.0', '2.1.319', '2026-10-16T10:00:00.000Z'),
      ],
      opts,
    );
    expect(text.split('\n')[0]).toBe(
      'aheen-agent · plugin 0.7.0 · Claude Code 2.1.319 · win32 · last 2h',
    );
    expect(formatTimeline([ev({ kind: 'dropped', count: 1 })], opts).split('\n')[0]).toBe(
      'aheen-agent · plugin unknown · Claude Code unknown · unknown · last 2h',
    );
  });
});
