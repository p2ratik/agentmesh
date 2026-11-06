import { describe, expect, it } from 'vitest';
import { type ConfigError, configFromObject } from './load';

const load = (observability?: object) =>
  configFromObject({
    version: 1,
    mesh: { name: 'x' },
    humans: [{ id: 'alice', displayName: 'Alice' }],
    ...(observability ? { observability } : {}),
  });

describe('observability config', () => {
  it('has defaults when the section is omitted', () => {
    expect(load().config.observability).toEqual({
      enabled: true,
      viewers: [],
      retentionDays: 14,
      maxEventsPerMinute: 300,
      client: { maxBufferedEvents: 500 },
    });
  });

  it('accepts a configured human as viewer', () => {
    expect(load({ viewers: ['alice'] }).config.observability.viewers).toEqual(['alice']);
  });

  it('refuses a viewer who is not a human', () => {
    const err = (() => {
      try {
        load({ viewers: ['ghost'] });
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err?.issues).toContainEqual({
      path: 'observability.viewers[0]',
      message: 'observability.viewers: "ghost" is not a human in this mesh',
    });
  });

  it('refuses retention under 1 day and a tiny buffer', () => {
    expect(() => load({ retentionDays: 0 })).toThrow();
    expect(() => load({ client: { maxBufferedEvents: 49 } })).toThrow();
  });
});
