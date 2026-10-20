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
  readonly #max: number;
  /** In window-start order, so the first entries are the oldest. */
  readonly #windows = new Map<string, { start: number; repeats: number }>();

  /** `max` bounds memory when clients spray new keys at the public port. */
  constructor(windowMs: number, clock: Clock, max = 10_000) {
    this.#windowMs = windowMs;
    this.#clock = clock;
    this.#max = max;
  }

  get size(): number {
    return this.#windows.size;
  }

  note(key: string): { level: 'warn' | 'debug'; repeated?: number } {
    const now = this.#clock.now().getTime();
    const window = this.#windows.get(key);
    if (window && now - window.start < this.#windowMs) {
      window.repeats += 1;
      return { level: 'debug' };
    }
    this.#windows.delete(key);
    this.#windows.set(key, { start: now, repeats: 0 });
    if (this.#windows.size > this.#max) this.#evict(now);
    return window && window.repeats > 0
      ? { level: 'warn', repeated: window.repeats }
      : { level: 'warn' };
  }

  /** Drops expired windows, then the oldest ones until it is back under the cap. */
  #evict(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
    for (const key of this.#windows.keys()) {
      if (this.#windows.size <= this.#max) break;
      this.#windows.delete(key);
    }
  }
}
