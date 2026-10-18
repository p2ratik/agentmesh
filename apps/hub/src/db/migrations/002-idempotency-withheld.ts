/**
 * Marks idempotency rows whose response was not stored (methods with
 * `cacheResponse: false`). Their `response` column holds `null`.
 */
export const MIGRATION_002 = `
ALTER TABLE rpc_idempotency ADD COLUMN withheld INTEGER NOT NULL DEFAULT 0;
`;
