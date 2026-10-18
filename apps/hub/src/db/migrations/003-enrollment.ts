/**
 * Invite-only onboarding: invites (only the secret's sha256 is kept) and the
 * team registry of enrolled members. Also rebuilds `rpc_idempotency` keyed
 * by (caller, key, method) with a `pending` flag, so the router can reserve a
 * key before running the handler and a key reused for another method never
 * touches the first method's row.
 */
export const MIGRATION_003 = `
CREATE TABLE rpc_idempotency_v3 (
  caller TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  response TEXT NOT NULL,
  withheld INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (caller, key, method)
);
INSERT INTO rpc_idempotency_v3 (caller, key, method, response, withheld, created_at)
  SELECT caller, key, method, response, withheld, created_at FROM rpc_idempotency;
DROP TABLE rpc_idempotency;
ALTER TABLE rpc_idempotency_v3 RENAME TO rpc_idempotency;

CREATE TABLE enrollment_invites (
  id TEXT PRIMARY KEY,
  secret_sha256 TEXT NOT NULL,
  human_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  roles TEXT NOT NULL,
  skills TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE enrollment_members (
  human_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  discord_user_id TEXT,
  roles TEXT NOT NULL,
  skills TEXT NOT NULL,
  nkey TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  invited_by TEXT NOT NULL,
  invite_id TEXT NOT NULL REFERENCES enrollment_invites(id),
  joined_at TEXT NOT NULL,
  removed_at TEXT
);
`;
