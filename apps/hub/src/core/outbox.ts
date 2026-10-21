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
 * Each recipient's oldest pending rows, at most BATCH each, so a recipient whose
 * messages wait for a session never starves the others.
 * ponytail: more than BATCH rows waiting on one held session also hold back that
 * agent's later rows for other threads; page per thread if that ever happens.
 */
const PENDING_DELIVERIES = `
  SELECT message_id, recipient_id, payload FROM (
    SELECT message_id, recipient_id, payload, created_at, rowid AS seq,
      ROW_NUMBER() OVER (PARTITION BY recipient_id ORDER BY created_at, rowid) AS n
    FROM deliveries WHERE state = 'pending')
  WHERE n <= ${BATCH} ORDER BY created_at, seq`;

/**
 * SQLite-backed outbox. Rows are written in the caller's transaction and
 * delivered afterwards, so an outage delays delivery but never loses it.
 * Each recipient gets its pending messages as one batch, and recipients run
 * concurrently, so one slow recipient never delays another. The ids the port
 * returns are marked published in one transaction with the receipt's `commit`;
 * the rest stay pending without counting an attempt (per-thread order is the
 * port's job). Feed events stop at the first failure to keep their order.
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
    const rows = this.#db.all<DeliveryRow>(PENDING_DELIVERIES);
    const byRecipient = Map.groupBy(rows, (row) => row.recipient_id);
    // ponytail: a flush ends with its slowest recipient, so rows enqueued meanwhile wait up to
    // one transport timeout (the dead session is then away and skipped); per-recipient loops
    // if that ever matters.
    const results = await Promise.allSettled(
      [...byRecipient].map(([recipientId, batch]) => this.#deliverTo(recipientId, batch)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.#logger.error({ err: result.reason }, 'delivery bookkeeping failed');
      } else if (result.value) {
        this.#again = true;
      }
    }
  }

  /** Returns whether more rows may be ready behind this batch. A batch that only waits must not spin. */
  async #deliverTo(recipientId: string, rows: DeliveryRow[]): Promise<boolean> {
    try {
      const messages = rows.map((row) => JSON.parse(row.payload) as MeshMessage);
      const receipt = await this.#delivery.deliver(recipientId, messages);
      const at = this.#clock.now().toISOString();
      this.#db.transaction(() => {
        for (const messageId of receipt.delivered) {
          this.#db.run(
            `UPDATE deliveries SET state = 'published', published_at = $at, attempts = attempts + 1
             WHERE message_id = $messageId AND recipient_id = $recipientId`,
            { at, messageId, recipientId },
          );
        }
        receipt.commit?.();
      });
      return rows.length === BATCH && receipt.delivered.length > 0;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      this.#db.transaction(() => {
        for (const row of rows) {
          this.#db.run(
            `UPDATE deliveries SET attempts = attempts + 1, last_error = $error
             WHERE message_id = $messageId AND recipient_id = $recipientId`,
            { error: message, messageId: row.message_id, recipientId },
          );
        }
      });
      this.#logger.warn({ err: error, recipient: recipientId }, 'delivery failed; will retry');
      return false;
    }
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
