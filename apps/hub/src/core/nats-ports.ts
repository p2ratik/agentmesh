import { type JetStreamClient, publishJson } from '@agentmesh/bus';
import { type DomainEvent, type MeshMessage, subjects } from '@agentmesh/protocol';
import type { DeliveryPort, DeliveryReceipt, EventPort } from '../ports';

/** Publishes deliveries and feed events to JetStream with dedup ids. */
export class NatsPorts implements DeliveryPort, EventPort {
  readonly #js: JetStreamClient;
  readonly #subjects: ReturnType<typeof subjects>;

  constructor(js: JetStreamClient, prefix: string) {
    this.#js = js;
    this.#subjects = subjects(prefix);
  }

  /** In order; a failure throws and the batch retries (JetStream's dedup window drops repeats). */
  async deliver(recipientId: string, messages: MeshMessage[]): Promise<DeliveryReceipt> {
    for (const message of messages) {
      await publishJson(
        this.#js,
        this.#subjects.deliver(recipientId),
        message,
        `${message.id}:${recipientId}`,
      );
    }
    return { delivered: messages.map((m) => m.id) };
  }

  async publish(event: DomainEvent): Promise<void> {
    await publishJson(this.#js, this.#subjects.event(event.type), event, event.id);
  }
}
