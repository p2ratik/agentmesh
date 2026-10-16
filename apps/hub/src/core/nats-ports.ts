import { type JetStreamClient, publishJson } from '@agentmesh/bus';
import { type DomainEvent, type MeshMessage, subjects } from '@agentmesh/protocol';
import type { DeliveryPort, EventPort } from '../ports';

/** Publishes deliveries and feed events to JetStream with dedup ids. */
export class NatsPorts implements DeliveryPort, EventPort {
  readonly #js: JetStreamClient;
  readonly #subjects: ReturnType<typeof subjects>;

  constructor(js: JetStreamClient, prefix: string) {
    this.#js = js;
    this.#subjects = subjects(prefix);
  }

  async deliver(recipientId: string, message: MeshMessage): Promise<void> {
    await publishJson(
      this.#js,
      this.#subjects.deliver(recipientId),
      message,
      `${message.id}:${recipientId}`,
    );
  }

  async publish(event: DomainEvent): Promise<void> {
    await publishJson(this.#js, this.#subjects.event(event.type), event, event.id);
  }
}
