/** Injected wherever time matters so tests can control it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can move forward by hand. */
export class ManualClock implements Clock {
  #current: Date;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.#current = new Date(start);
  }

  now(): Date {
    return new Date(this.#current);
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }

  set(at: Date | string): void {
    this.#current = new Date(at);
  }
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function toIso(date: Date): string {
  return date.toISOString();
}
