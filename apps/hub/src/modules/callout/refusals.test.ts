import { ManualClock, MINUTE_MS } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import { RefusalLog } from './refusals';

describe('RefusalLog', () => {
  it('warns once per key and window, then reports how often it repeated', () => {
    const clock = new ManualClock();
    const log = new RefusalLog(10 * MINUTE_MS, clock);
    expect(log.note('UKEY|unknown key')).toEqual({ level: 'warn' });
    for (let i = 0; i < 250; i++) {
      clock.advance(2000);
      expect(log.note('UKEY|unknown key').level).toBe('debug');
    }
    clock.advance(2 * MINUTE_MS); // 8m20s + 2m: the window has ended
    expect(log.note('UKEY|unknown key')).toEqual({ level: 'warn', repeated: 250 });
  });

  it('keeps keys apart', () => {
    const log = new RefusalLog(10 * MINUTE_MS, new ManualClock());
    expect(log.note('UA|unknown key').level).toBe('warn');
    expect(log.note('UB|unknown key').level).toBe('warn');
    expect(log.note('UA|bad nkey signature').level).toBe('warn');
    expect(log.note('UA|unknown key').level).toBe('debug');
  });

  it('starts over after a quiet window without reporting repeats', () => {
    const clock = new ManualClock();
    const log = new RefusalLog(10 * MINUTE_MS, clock);
    log.note('UKEY|unknown key');
    clock.advance(11 * MINUTE_MS);
    expect(log.note('UKEY|unknown key')).toEqual({ level: 'warn' });
  });
});
