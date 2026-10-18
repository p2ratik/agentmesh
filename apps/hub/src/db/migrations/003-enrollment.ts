/**
 * Invite-only onboarding: invites (only the secret's sha256 is kept) and the
 * team registry of enrolled members. Also lets the router reserve an
 * idempotency key before running the handler (`pending = 1`), so two
 * overlapping calls with the same key cannot both run.
 */
export const MIGRATION_003 = `
ALTER TABLE rpc_idempotency ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;

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
