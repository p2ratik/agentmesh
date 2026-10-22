/** The outbox's contract (re-exported from `contracts.ts`). */
import type {
  DeliveryClass,
  DomainEventData,
  DomainEventType,
  MeshMessage,
} from '@agentmesh/protocol';

/**
 * Transactional outbox: services write deliveries/events inside the same DB
 * transaction as their state change; a dispatcher publishes them to NATS.
 */
export interface Outbox {
  enqueueDelivery(
    message: MeshMessage,
    recipientId: string,
    held: boolean,
    /** The recipient's delivery class; `action` when omitted. */
    cls?: DeliveryClass,
  ): void;
  enqueueEvent<T extends DomainEventType>(type: T, data: DomainEventData<T>): void;
  /** Schedules a flush without awaiting it. Call after committing. */
  kick(): void;
  flush(): Promise<void>;
  /** Kill-switch pause: pending deliveries become held. Returns how many. */
  holdPending(): number;
  /** Kill-switch resume: held deliveries become pending. Returns how many. */
  releaseHeld(): number;
  heldCount(): number;
}
