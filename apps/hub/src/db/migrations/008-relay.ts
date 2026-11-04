/**
 * Closed askers (plan 3): whether a session was private (inactive, not the mesh window) when it
 * closed, its Claude Code conversation id, and the replies whose private asker closed that wait
 * for the owner's decision (one row per thread and agent, escalated once at `due_at` and kept
 * until the thread is owned or closed, so a closed asker gets one notice and one escalation).
 */
export const MIGRATION_008 = `
ALTER TABLE sessions ADD COLUMN private_at_close INTEGER NOT NULL DEFAULT 0
  CHECK (private_at_close IN (0, 1));
ALTER TABLE sessions ADD COLUMN claude_session_id TEXT;
CREATE TABLE orphan_decisions (
  thread_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  released_by TEXT NOT NULL,
  due_at TEXT NOT NULL,
  escalated_at TEXT,
  PRIMARY KEY (thread_id, agent_id)
);
CREATE INDEX orphan_decisions_due ON orphan_decisions (due_at);
`;
