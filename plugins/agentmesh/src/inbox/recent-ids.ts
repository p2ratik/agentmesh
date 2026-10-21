/** Remembers recently seen ids so redelivered messages are not pushed twice. */
export class RecentIds {
  readonly #max: number;
  readonly #ids = new Set<string>();

  constructor(max = 2000) {
    this.#max = max;
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** Records an id that reached Claude Code; true the first time it is recorded. */
  remember(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    if (this.#ids.size > this.#max) {
      const oldest = this.#ids.values().next().value;
      if (oldest !== undefined) this.#ids.delete(oldest);
    }
    return true;
  }
}
