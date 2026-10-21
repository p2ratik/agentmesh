import type { DomainEvent, MeshMessage } from '@agentmesh/protocol';

/** What a delivery handed over, and the database writes that go with it. */
export interface DeliveryReceipt {
  /** Ids of the messages delivered; the rest stay pending. */
  delivered: string[];
  /**
   * Follow-up writes for the delivered messages. Synchronous and DB only: it
   * runs inside the transaction that marks them published.
   */
  commit?: () => void;
}

/** Where the outbox publishes. NATS in production, in-memory in tests. */
export interface DeliveryPort {
  /**
   * Hands one recipient its pending messages, oldest first. Must be
   * idempotent per (message, recipient): a message can be handed over again.
   */
  deliver(recipientId: string, messages: MeshMessage[]): Promise<DeliveryReceipt>;
}

export interface EventPort {
  /** Publish to the activity feed. Must be idempotent per event id. */
  publish(event: DomainEvent): Promise<void>;
}

/** Records everything; used by unit tests. */
export class MemoryPorts implements DeliveryPort, EventPort {
  readonly deliveries: Array<{ recipientId: string; message: MeshMessage }> = [];
  readonly events: DomainEvent[] = [];
  /** Fails the next N calls; with `failRecipient` set, only deliveries to that recipient. */
  failNext = 0;
  failRecipient: string | null = null;

  async deliver(recipientId: string, messages: MeshMessage[]): Promise<DeliveryReceipt> {
    if (this.failRecipient === null || this.failRecipient === recipientId) this.#maybeFail();
    for (const message of messages) this.deliveries.push({ recipientId, message });
    return { delivered: messages.map((m) => m.id) };
  }

  async publish(event: DomainEvent): Promise<void> {
    if (this.failRecipient === null) this.#maybeFail();
    this.events.push(event);
  }

  deliveredTo(recipientId: string): MeshMessage[] {
    return this.deliveries.filter((d) => d.recipientId === recipientId).map((d) => d.message);
  }

  #maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('simulated transport failure');
    }
  }
}
