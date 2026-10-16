import { Lru } from './lru';

/**
 * Prevents echo loops. A human's Discord reply is relayed to the hub and comes
 * back on the activity feed as `message.created`; it is already visible in
 * Discord, so the feed must skip it.
 *
 * The feed event can arrive before the `message.send` reply that tells us the
 * message id, so `isEcho` waits for relays still in flight before answering.
 */
export class EchoGuard {
  readonly #relayed: Lru<string, true>;
  readonly #pending = new Set<Promise<void>>();

  constructor(capacity = 2_000) {
    this.#relayed = new Lru(capacity);
  }

  remember(messageId: string): void {
    this.#relayed.set(messageId, true);
  }

  /** Registers a relay whose promise resolves to the mesh message id; returns it unchanged. */
  track(relay: Promise<string>): Promise<string> {
    const settled: Promise<void> = relay
      .then((id) => this.remember(id))
      .catch(() => undefined)
      .finally(() => this.#pending.delete(settled));
    this.#pending.add(settled);
    return relay;
  }

  async isEcho(messageId: string): Promise<boolean> {
    if (!this.#relayed.has(messageId) && this.#pending.size > 0) {
      await Promise.all(this.#pending);
    }
    return this.#relayed.has(messageId);
  }
}
