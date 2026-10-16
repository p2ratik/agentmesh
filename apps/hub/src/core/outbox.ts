import { type Clock, type Logger, newEventId } from '@agentmesh/common';
import type {
  DomainEvent,
  DomainEventData,
  DomainEventType,
  MeshMessage,
} from '@agentmesh/protocol';
import type { Outbox } from '../contracts';
import type { Db } from '../db/database';
import type { DeliveryPort, EventPort } from '../ports';

interface DeliveryRow {
  message_id: string;
  recipient_id: string;
  payload: string;
}

interface EventRow {
  seq: number;
  payload: string;
}

const BATCH = 200;

/**
 * SQLite-backed outbox. Rows are written in the caller's transaction and
 * published afterwards, so a NATS outage delays delivery but never loses it.
 * Per-recipient order is preserved: after a failed delivery, later messages
 * for that recipient wait for the next flush. Feed events stop at the first
 * failure to keep their order.
 */
export class SqliteOutbox implements Outbox {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #delivery: DeliveryPort;
  readonly #events: EventPort;
  #flushing: Promise<void> | null = null;
  #again = false;
  #scheduled = false;

  constructor(db: Db, clock: Clock, logger: Logger, delivery: DeliveryPort, events: EventPort) {
    this.#db = db;
    this.#clock = clock;
    this.#logger = logger;
    this.#delivery = delivery;
    this.#events = events;
  }

  enqueueDelivery(message: MeshMessage, recipientId: string, held: boolean): void {
    this.#db.run(
      `INSERT OR IGNORE INTO deliveries (message_id, recipient_id, payload, state, created_at)
       VALUES ($messageId, $recipientId, $payload, $state, $at)`,
      {
        messageId: message.id,
        recipientId,
        payload: JSON.stringify(message),
        state: held ? 'held' : 'pending',
        at: this.#clock.now().toISOString(),
      },
    );
  }

  enqueueEvent<T extends DomainEventType>(type: T, data: DomainEventData<T>): void {
    const at = this.#clock.now().toISOString();
    const event = { id: newEventId(), type, at, data } as DomainEvent;
    this.#db.run(
      'INSERT INTO event_outbox (id, type, payload, created_at) VALUES ($id, $type, $payload, $at)',
      { id: event.id, type, payload: JSON.stringify(event), at },
    );
  }

  kick(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      this.flush().catch((err) => this.#logger.error({ err }, 'outbox flush failed'));
    });
  }

  flush(): Promise<void> {
    if (this.#flushing) {
      this.#again = true;
      return this.#flushing;
    }
    this.#flushing = (async () => {
      try {
        do {
          this.#again = false;
          await this.#flushDeliveries();
          await this.#flushEvents();
        } while (this.#again);
      } finally {
        this.#flushing = null;
      }
    })();
    return this.#flushing;
  }

  releaseHeld(): number {
    const { changes } = this.#db.run(
      "UPDATE deliveries SET state = 'pending' WHERE state = 'held'",
    );
    if (changes > 0) this.kick();
    return changes;
  }

  heldCount(): number {
    return (
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'held'")?.n ??
      0
    );
  }

  /** Deletes published rows older than `before` (housekeeping tick). */
  prune(before: Date): void {
    const at = before.toISOString();
    this.#db.run("DELETE FROM deliveries WHERE state = 'published' AND published_at < $at", { at });
    this.#db.run('DELETE FROM event_outbox WHERE published_at IS NOT NULL AND published_at < $at', {
      at,
    });
  }

  async #flushDeliveries(): Promise<void> {
    const rows = this.#db.all<DeliveryRow>(
      `SELECT message_id, recipient_id, payload FROM deliveries
       WHERE state = 'pending' ORDER BY created_at, rowid LIMIT ${BATCH}`,
    );
    const blocked = new Set<string>();
    for (const row of rows) {
      if (blocked.has(row.recipient_id)) continue;
      try {
        await this.#delivery.deliver(row.recipient_id, JSON.parse(row.payload) as MeshMessage);
        this.#db.run(
          `UPDATE deliveries SET state = 'published', published_at = $at, attempts = attempts + 1
           WHERE message_id = $messageId AND recipient_id = $recipientId`,
          {
            at: this.#clock.now().toISOString(),
            messageId: row.message_id,
            recipientId: row.recipient_id,
          },
        );
      } catch (error) {
        blocked.add(row.recipient_id);
        this.#db.run(
          `UPDATE deliveries SET attempts = attempts + 1, last_error = $error
           WHERE message_id = $messageId AND recipient_id = $recipientId`,
          {
            error: String((error as Error)?.message ?? error),
            messageId: row.message_id,
            recipientId: row.recipient_id,
          },
        );
        this.#logger.warn(
          { err: error, recipient: row.recipient_id },
          'delivery publish failed; will retry',
        );
      }
    }
    if (rows.length === BATCH) this.#again = true;
  }

  async #flushEvents(): Promise<void> {
    const rows = this.#db.all<EventRow>(
      `SELECT seq, payload FROM event_outbox WHERE published_at IS NULL ORDER BY seq LIMIT ${BATCH}`,
    );
    for (const row of rows) {
      try {
        await this.#events.publish(JSON.parse(row.payload) as DomainEvent);
        this.#db.run(
          'UPDATE event_outbox SET published_at = $at, attempts = attempts + 1 WHERE seq = $seq',
          {
            at: this.#clock.now().toISOString(),
            seq: row.seq,
          },
        );
      } catch (error) {
        this.#db.run(
          'UPDATE event_outbox SET attempts = attempts + 1, last_error = $error WHERE seq = $seq',
          {
            error: String((error as Error)?.message ?? error),
            seq: row.seq,
          },
        );
        this.#logger.warn({ err: error }, 'event publish failed; will retry');
        return;
      }
    }
    if (rows.length === BATCH) this.#again = true;
  }
}
