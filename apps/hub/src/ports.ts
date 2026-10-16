import type { DomainEvent, MeshMessage } from '@agentmesh/protocol';

/** Where the outbox publishes. NATS in production, in-memory in tests. */
export interface DeliveryPort {
  /** Publish to a participant's durable inbox. Must be idempotent per (message, recipient). */
  deliver(recipientId: string, message: MeshMessage): Promise<void>;
}

export interface EventPort {
  /** Publish to the activity feed. Must be idempotent per event id. */
  publish(event: DomainEvent): Promise<void>;
}

/** Records everything; used by unit tests. */
export class MemoryPorts implements DeliveryPort, EventPort {
  readonly deliveries: Array<{ recipientId: string; message: MeshMessage }> = [];
  readonly events: DomainEvent[] = [];
  failNext = 0;

  async deliver(recipientId: string, message: MeshMessage): Promise<void> {
    this.#maybeFail();
    this.deliveries.push({ recipientId, message });
  }

  async publish(event: DomainEvent): Promise<void> {
    this.#maybeFail();
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
