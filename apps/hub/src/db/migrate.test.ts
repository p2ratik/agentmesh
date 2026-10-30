import { describe, expect, it } from 'vitest';
import { Db } from './database';
import { migrate } from './migrate';
import { MIGRATION_001 } from './migrations/001-init';
import { MIGRATION_002 } from './migrations/002-idempotency-withheld';
import { MIGRATION_003 } from './migrations/003-enrollment';
import { MIGRATION_004 } from './migrations/004-sessions';

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
    expect(migrate(db)).toBe(4);
    expect(db.all('SELECT caller, key, method, response, pending FROM rpc_idempotency')).toEqual([
      { caller: 'alice-agent', key: 'k1', method: 'task.get', response: '{"ok":1}', pending: 0 },
    ]);
    expect(migrate(db)).toBe(0);
  });

  it('migration 005 backfills thread_key from the payload', () => {
    const db = new Db(':memory:');
    for (const sql of [MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004]) db.exec(sql);
    db.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
       INSERT INTO schema_migrations VALUES (1, 'x'), (2, 'x'), (3, 'x'), (4, 'x');
       INSERT INTO deliveries (message_id, recipient_id, payload, state, created_at)
         VALUES ('msg-1', 'bob-agent', '{"id":"msg-1","threadId":"thr-3"}', 'pending',
           '2026-10-16T09:00:00.000Z');
       INSERT INTO sessions (id, agent_id, active, liveness, client_version, created_at, last_seen)
         VALUES ('s-aaaaaaaaaaaa', 'bob-agent', 1, 'live', '0.4.1', 'x', 'x');`,
    );
    expect(migrate(db)).toBe(2);
    expect(db.all('SELECT message_id, state, class, thread_key FROM deliveries')).toEqual([
      { message_id: 'msg-1', state: 'pending', class: 'action', thread_key: 'thr-3' },
    ]);
    // 006: sessions from before pull mode were activated with a push check.
    expect(db.all('SELECT id, delivery FROM sessions')).toEqual([
      { id: 's-aaaaaaaaaaaa', delivery: 'push' },
    ]);
  });
});
