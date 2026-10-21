import { describe, expect, it } from 'vitest';
import { Db } from './database';
import { migrate } from './migrate';
import { MIGRATION_001 } from './migrations/001-init';
import { MIGRATION_002 } from './migrations/002-idempotency-withheld';

describe('migrations', () => {
  it('upgrades a live v2 database and keeps its idempotency rows', () => {
    const db = new Db(':memory:');
    db.exec(MIGRATION_001);
    db.exec(MIGRATION_002);
    db.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
       INSERT INTO schema_migrations VALUES (1, 'x'), (2, 'x');
       INSERT INTO rpc_idempotency (caller, key, method, response, withheld, created_at)
         VALUES ('alice-agent', 'k1', 'task.get', '{"ok":1}', 0, '2026-10-16T09:00:00.000Z');`,
    );
    expect(migrate(db)).toBe(2);
    expect(db.all('SELECT caller, key, method, response, pending FROM rpc_idempotency')).toEqual([
      { caller: 'alice-agent', key: 'k1', method: 'task.get', response: '{"ok":1}', pending: 0 },
    ]);
    expect(migrate(db)).toBe(0);
  });
});
