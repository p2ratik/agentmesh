import { describe, expect, it } from 'vitest';
import { anyFresh } from './heartbeat';

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
