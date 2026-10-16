import type { Clock } from '@agentmesh/common';
import type { Db } from '../db/database';

/** Remembers RPC results per (caller, idempotency key) so retries are safe. */
export class IdempotencyStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  get(caller: string, key: string, method: string): { found: boolean; response?: unknown } {
    const row = this.#db.get<{ method: string; response: string }>(
      'SELECT method, response FROM rpc_idempotency WHERE caller = $caller AND key = $key',
      { caller, key },
    );
    if (!row || row.method !== method) return { found: false };
    return { found: true, response: JSON.parse(row.response) };
  }

  put(caller: string, key: string, method: string, response: unknown): void {
    this.#db.run(
      `INSERT OR REPLACE INTO rpc_idempotency (caller, key, method, response, created_at)
       VALUES ($caller, $key, $method, $response, $at)`,
      {
        caller,
        key,
        method,
        response: JSON.stringify(response ?? null),
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
