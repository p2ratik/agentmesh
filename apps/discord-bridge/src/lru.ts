/**
 * A size-bounded map that evicts the least recently used entry. Backs every
 * in-memory cache in the bridge so a long-running process never grows unbounded.
 */
export class Lru<K, V> {
  readonly #max: number;
  readonly #entries = new Map<K, V>();

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`Lru size must be >= 1, got ${max}`);
    this.#max = max;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  /** Returns the value and marks it as recently used. */
  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as V;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }
}
