import type { Clock } from '@agentmesh/common';
import type { Db } from '../db/database';

export type IdempotencyLookup =
  | { found: false }
  | { found: true; withheld: false; response: unknown }
  /** The call completed, but its response was deliberately not stored. */
  | { found: true; withheld: true };

/** Remembers RPC results per (caller, idempotency key) so retries are safe. */
export class IdempotencyStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  get(caller: string, key: string, method: string): IdempotencyLookup {
    const row = this.#db.get<{ method: string; response: string; withheld: number }>(
      'SELECT method, response, withheld FROM rpc_idempotency WHERE caller = $caller AND key = $key',
      { caller, key },
    );
    if (!row || row.method !== method) return { found: false };
    if (row.withheld) return { found: true, withheld: true };
    return { found: true, withheld: false, response: JSON.parse(row.response) };
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
      `INSERT OR REPLACE INTO rpc_idempotency (caller, key, method, response, withheld, created_at)
       VALUES ($caller, $key, $method, $response, $withheld, $at)`,
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
