import type { Clock } from '@agentmesh/common';
import type { Db } from '../db/database';

export type IdempotencyLookup =
  | { found: false }
  | { found: true; pending: false; withheld: false; response: unknown }
  /** The call completed, but its response was deliberately not stored. */
  | { found: true; pending: false; withheld: true }
  /** A call with this key is still running. */
  | { found: true; pending: true };

/** Remembers RPC results per (caller, idempotency key) so retries are safe. */
export class IdempotencyStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  get(caller: string, key: string, method: string): IdempotencyLookup {
    const row = this.#db.get<{
      method: string;
      response: string;
      withheld: number;
      pending: number;
    }>(
      'SELECT method, response, withheld, pending FROM rpc_idempotency WHERE caller = $caller AND key = $key',
      { caller, key },
    );
    if (!row || row.method !== method) return { found: false };
    if (row.pending) return { found: true, pending: true };
    if (row.withheld) return { found: true, pending: false, withheld: true };
    return { found: true, pending: false, withheld: false, response: JSON.parse(row.response) };
  }

  /**
   * Claims the key before the handler runs, so an overlapping call with the
   * same key sees `pending` instead of running the handler a second time.
   * Leaves an existing row (another method's) untouched.
   */
  reserve(caller: string, key: string, method: string): void {
    this.#db.run(
      `INSERT OR IGNORE INTO rpc_idempotency (caller, key, method, response, withheld, pending, created_at)
       VALUES ($caller, $key, $method, 'null', 0, 1, $at)`,
      { caller, key, method, at: this.#clock.now().toISOString() },
    );
  }

  /** Drops a reservation whose handler failed, so the caller can retry with the same key. */
  release(caller: string, key: string): void {
    this.#db.run(
      'DELETE FROM rpc_idempotency WHERE caller = $caller AND key = $key AND pending = 1',
      { caller, key },
    );
  }

  /** Records a completed call. With `withhold`, only the key is kept, never the response. */
  put(
    caller: string,
    key: string,
    method: string,
    response: unknown,
    options: { withhold?: boolean } = {},
  ): void {
    const withhold = options.withhold ?? false;
    this.#db.run(
      `INSERT OR REPLACE INTO rpc_idempotency (caller, key, method, response, withheld, pending, created_at)
       VALUES ($caller, $key, $method, $response, $withheld, 0, $at)`,
      {
        caller,
        key,
        method,
        response: withhold ? 'null' : JSON.stringify(response ?? null),
        withheld: withhold ? 1 : 0,
        at: this.#clock.now().toISOString(),
      },
    );
  }

  prune(before: Date): void {
    this.#db.run('DELETE FROM rpc_idempotency WHERE created_at < $at', {
      at: before.toISOString(),
    });
  }
}
