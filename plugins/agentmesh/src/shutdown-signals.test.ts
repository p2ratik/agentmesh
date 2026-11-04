import { describe, expect, it } from 'vitest';
import { once, shutdownSignals, watchSignals } from './shutdown-signals';

describe('shutdownSignals', () => {
  it('includes SIGHUP and SIGBREAK on Windows, where closing the window sends SIGHUP', () => {
    expect(shutdownSignals('win32')).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']);
  });

  it('includes SIGHUP elsewhere', () => {
    expect(shutdownSignals('linux')).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
  });
});

describe('watchSignals', () => {
  it('registers every signal with the shutdown, naming the signal as the reason', () => {
    const seen: string[] = [];
    const handlers = new Map<string, () => void>();
    watchSignals('linux', { on: (s, h) => handlers.set(s, h) }, (r) => seen.push(r));
    handlers.get('SIGHUP')?.();
    expect([...handlers.keys()]).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
    expect(seen).toEqual(['SIGHUP']);
  });
});

describe('once', () => {
  it('runs the shutdown a single time, so a second signal sends no second bye', () => {
    let byes = 0;
    const stop = once((_reason: string) => {
      byes += 1;
    });
    stop('SIGHUP');
    stop('stdin close');
    expect(byes).toBe(1);
  });
});
