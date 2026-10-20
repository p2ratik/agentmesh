import type { Clock } from '@agentmesh/common';

/**
 * Keeps refusal logs readable: plugins retry refused connects every few
 * seconds, so a removed member's open session would log one line each time.
 * The first refusal per key in a window is a warning, repeats are debug, and
 * the next warning after the window says how many were folded into it.
 * ponytail: in memory, so a hub restart starts every key over. No timer, so a
 * key that goes quiet never reports its last window's count.
 */
export class RefusalLog {
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #windows = new Map<string, { start: number; repeats: number }>();

  constructor(windowMs: number, clock: Clock) {
    this.#windowMs = windowMs;
    this.#clock = clock;
  }

  note(key: string): { level: 'warn' | 'debug'; repeated?: number } {
    const now = this.#clock.now().getTime();
    const window = this.#windows.get(key);
    if (window && now - window.start < this.#windowMs) {
      window.repeats += 1;
      return { level: 'debug' };
    }
    this.#windows.set(key, { start: now, repeats: 0 });
    if (this.#windows.size > 10_000) this.#sweep(now);
    return window && window.repeats > 0
      ? { level: 'warn', repeated: window.repeats }
      : { level: 'warn' };
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
