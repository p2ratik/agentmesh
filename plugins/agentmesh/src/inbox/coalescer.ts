import type { MeshMessage } from '@agentmesh/protocol';

interface Pending {
  messages: MeshMessage[];
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

/**
 * Batches messages that arrive close together (e.g. the backlog after a laptop
 * wakes up) into one channel event per thread. `add` resolves once that
 * thread's event was emitted, so the inbox only acks what reached Claude Code.
 */
export class Coalescer {
  readonly #windowMs: number;
  readonly #emit: (messages: MeshMessage[]) => Promise<void>;
  #pending = new Map<string, Pending>();
  #timer: NodeJS.Timeout | null = null;

  constructor(windowMs: number, emit: (messages: MeshMessage[]) => Promise<void>) {
    this.#windowMs = windowMs;
    this.#emit = emit;
  }

  add(message: MeshMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = this.#pending.get(message.threadId) ?? { messages: [], waiters: [] };
      entry.messages.push(message);
      entry.waiters.push({ resolve, reject });
      this.#pending.set(message.threadId, entry);
      this.#timer ??= setTimeout(() => void this.flush(), this.#windowMs);
    });
  }

  /** Emits every buffered thread now (also used on shutdown). */
  async flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const batch = this.#pending;
    this.#pending = new Map();
    for (const { messages, waiters } of batch.values()) {
      messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      try {
        await this.#emit(messages);
        for (const w of waiters) w.resolve();
      } catch (error) {
        for (const w of waiters) w.reject(error);
      }
    }
  }
}

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
