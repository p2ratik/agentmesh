import { type Clock, MINUTE_MS } from '@agentmesh/common';

/**
 * Counts failures per key (an invite id, a client IP) in fixed one-minute
 * windows; a key is blocked once it reaches the limit. The callout's connect
 * budget counts every attempt with it, admitted or not.
 * ponytail: in memory, so a hub restart resets it and one hub only. Move it to
 * SQLite if the hub ever runs replicated.
 */
export class FailureLimiter {
  readonly #limit: number;
  readonly #clock: Clock;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, clock: Clock) {
    this.#limit = limit;
    this.#clock = clock;
  }

  blocked(key: string): boolean {
    return (this.#window(key)?.count ?? 0) >= this.#limit;
  }

  fail(key: string): void {
    const now = this.#clock.now().getTime();
    const window = this.#window(key) ?? { start: now, count: 0 };
    window.count += 1;
    this.#windows.set(key, window);
    if (this.#windows.size > 10_000) this.#sweep(now);
  }

  /** The key's current window, dropping it once a minute has passed. */
  #window(key: string): { start: number; count: number } | undefined {
    const window = this.#windows.get(key);
    if (window && this.#clock.now().getTime() - window.start >= MINUTE_MS) {
      this.#windows.delete(key);
      return undefined;
    }
    return window;
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= MINUTE_MS) this.#windows.delete(key);
    }
  }
}
