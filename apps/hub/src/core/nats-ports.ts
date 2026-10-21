import { type JetStreamClient, publishJson } from '@agentmesh/bus';
import { type DomainEvent, subjects } from '@agentmesh/protocol';
import type { EventPort } from '../ports';

/** Publishes feed events to JetStream with dedup ids. Deliveries go to sessions instead. */
export class NatsPorts implements EventPort {
  readonly #js: JetStreamClient;
  readonly #subjects: ReturnType<typeof subjects>;

  constructor(js: JetStreamClient, prefix: string) {
    this.#js = js;
    this.#subjects = subjects(prefix);
  }

  async publish(event: DomainEvent): Promise<void> {
    await publishJson(this.#js, this.#subjects.event(event.type), event, event.id);
  }
}
