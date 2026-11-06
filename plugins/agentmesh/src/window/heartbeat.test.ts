import { describe, expect, it } from 'vitest';
import { anyFresh, windowAddresses } from './heartbeat';

describe('anyFresh', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  const at = (ms: number) => ({ updatedAt: new Date(now + ms).toISOString() });
  it('is true for a heartbeat 60 s old', () => expect(anyFresh([at(-60_000)], now)).toBe(true));
  it('is false for 3 minutes old and for the future', () => {
    expect(anyFresh([at(-180_000)], now)).toBe(false);
    expect(anyFresh([at(60_000)], now)).toBe(false);
  });
  it('is false for junk', () => expect(anyFresh([null, 'x', {}], now)).toBe(false));
});

describe('windowAddresses', () => {
  const now = Date.parse('2026-11-04T10:00:00Z');
  const beat = (uds: string | null, over: Record<string, unknown> = {}) => ({
    agentId: 'bob-agent',
    prefix: 'mesh',
    sessionId: 's-aaaaaaaaaaaa',
    meshWindow: true,
    uds,
    updatedAt: new Date(now - 10_000).toISOString(),
    ...over,
  });

  it('lists only fresh mesh-window addresses of the same prefix and agent', () => {
    const values = [
      beat('uds:win'),
      beat('uds:plain', { meshWindow: false }),
      beat('uds:other-agent', { agentId: 'carol-agent' }),
      beat('uds:other-mesh', { prefix: 'acme' }),
      beat('uds:old', { updatedAt: new Date(now - 180_000).toISOString() }),
      beat('uds:future', { updatedAt: new Date(now + 60_000).toISOString() }),
      beat(''),
      beat(null),
      null,
      'junk',
    ];
    expect(windowAddresses(values, 'mesh', 'bob-agent', now)).toEqual(['uds:win']);
  });
});
