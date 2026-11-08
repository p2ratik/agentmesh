/**
 * Observability (plan 4): one row per behaviour event, from plugins and from the hub itself.
 * `body` is the validated event as JSON (ids, counts and codes only, never text). Pruned by age.
 */
export const MIGRATION_009 = `
CREATE TABLE events (
  id TEXT NOT NULL,
  agent TEXT NOT NULL,
  session TEXT,
  thread TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (agent, id)
);
CREATE INDEX events_agent ON events (agent, received_at);
CREATE INDEX events_session ON events (session, received_at);
CREATE INDEX events_thread ON events (thread, received_at);
CREATE INDEX events_received ON events (received_at);
`;
