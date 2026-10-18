import type { Db } from './database';
import { MIGRATION_001 } from './migrations/001-init';
import { MIGRATION_002 } from './migrations/002-idempotency-withheld';
import { MIGRATION_003 } from './migrations/003-enrollment';

/** Append-only. Never edit a shipped migration; add a new one. */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: MIGRATION_001 },
  { version: 2, sql: MIGRATION_002 },
  { version: 3, sql: MIGRATION_003 },
];

export function migrate(db: Db, now: () => Date = () => new Date()): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version),
  );
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES ($version, $at)', {
        version: migration.version,
        at: now().toISOString(),
      });
    });
    count += 1;
  }
  return count;
}
