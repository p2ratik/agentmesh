/**
 * Per-session delivery: one row per Claude Code session of an agent, and the
 * session that owns each thread (per agent). `released` holds the JSON array of
 * thread ids released at close, so a reopened session can reclaim them.
 */
export const MIGRATION_004 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  liveness TEXT NOT NULL CHECK (liveness IN ('live', 'away', 'closed')),
  description TEXT,
  repo TEXT,
  branch TEXT,
  client_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_seen TEXT NOT NULL,
  away_since TEXT,
  closed_at TEXT,
  released TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX sessions_by_agent ON sessions(agent_id, liveness);

CREATE TABLE thread_owners (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  since TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
);
CREATE INDEX thread_owners_by_session ON thread_owners(session_id);
`;
