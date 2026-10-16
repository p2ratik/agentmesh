/**
 * Initial schema. Integer ids are formatted at the edge (`thr-12`, `task-42`,
 * `plan-7`). JSON columns hold small arrays/objects. Times are ISO strings.
 */
export const MIGRATION_001 = `
CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human', 'service')),
  display_name TEXT NOT NULL,
  owner TEXT,
  declared_status TEXT NOT NULL DEFAULT 'online',
  status_note TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  repo TEXT,
  branch TEXT,
  last_seen TEXT,
  last_assigned_at TEXT,
  configured INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES threads(id),
  task_id INTEGER,
  plan_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX threads_updated ON threads(updated_at);

CREATE TABLE thread_participants (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  participant_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, participant_id)
);
CREATE INDEX thread_participants_by_participant ON thread_participants(participant_id);

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status TEXT,
  trust TEXT NOT NULL DEFAULT 'team',
  depth INTEGER NOT NULL DEFAULT 0,
  recipients TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id, seq);
CREATE INDEX messages_sender_time ON messages(sender_id, created_at);

CREATE TABLE deliveries (
  message_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'published')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (message_id, recipient_id)
);
CREATE INDEX deliveries_state ON deliveries(state);

CREATE TABLE event_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX event_outbox_pending ON event_outbox(published_at);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workflow TEXT NOT NULL,
  state TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  labels TEXT NOT NULL DEFAULT '[]',
  repo TEXT,
  area TEXT,
  base_branch TEXT,
  branch TEXT,
  pr_url TEXT,
  done_when TEXT,
  assignee TEXT,
  created_by TEXT NOT NULL,
  plan_id INTEGER,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  review_round INTEGER NOT NULL DEFAULT 0,
  declined_by TEXT NOT NULL DEFAULT '[]',
  trust TEXT NOT NULL DEFAULT 'team',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_assignee_state ON tasks(assignee, state);
CREATE INDEX tasks_plan ON tasks(plan_id);

CREATE TABLE task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX task_dependencies_reverse ON task_dependencies(depends_on);

CREATE TABLE task_reviewers (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  reviewer_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  PRIMARY KEY (task_id, reviewer_id, round)
);

CREATE TABLE task_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  reviewer_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  body TEXT NOT NULL,
  round INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX task_reviews_task ON task_reviews(task_id, round);

CREATE TABLE task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT
);
CREATE INDEX task_history_task ON task_history(task_id, id);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  state TEXT NOT NULL,
  template TEXT NOT NULL,
  initiator TEXT NOT NULL,
  facilitator TEXT NOT NULL,
  participants TEXT NOT NULL,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  rounds TEXT NOT NULL,
  round_index INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  require_approval INTEGER NOT NULL DEFAULT 0,
  facilitator_handoffs INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  drafts TEXT NOT NULL DEFAULT '[]',
  task_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX plans_state ON plans(state);

CREATE TABLE plan_contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  round TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX plan_contributions_plan ON plan_contributions(plan_id, round);

CREATE TABLE leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder TEXT NOT NULL,
  repo TEXT,
  path TEXT NOT NULL,
  reason TEXT,
  task_id INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX leases_holder ON leases(holder);
CREATE INDEX leases_expiry ON leases(expires_at);

CREATE TABLE external_refs (
  system TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  PRIMARY KEY (system, entity_type, entity_id)
);
CREATE UNIQUE INDEX external_refs_by_ref ON external_refs(system, ref);

CREATE TABLE ingest_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  payload TEXT NOT NULL,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  matched_rules TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX ingest_events_received ON ingest_events(received_at);

CREATE TABLE rule_throttles (
  rule_id TEXT NOT NULL,
  key TEXT NOT NULL,
  until TEXT NOT NULL,
  PRIMARY KEY (rule_id, key)
);

CREATE TABLE rpc_idempotency (
  caller TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (caller, key)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
