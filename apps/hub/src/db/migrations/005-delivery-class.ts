/**
 * Delivery classes: `status_for` lists the recipients for whom a message is
 * status (FYI) rather than action. Each outbox row carries its class and its
 * thread, so pending rows can be picked per (recipient, thread).
 */
export const MIGRATION_005 = `
ALTER TABLE messages ADD COLUMN status_for TEXT NOT NULL DEFAULT '[]';
ALTER TABLE deliveries ADD COLUMN class TEXT NOT NULL DEFAULT 'action'
  CHECK (class IN ('action', 'status'));
ALTER TABLE deliveries ADD COLUMN thread_key TEXT;
UPDATE deliveries SET thread_key = json_extract(payload, '$.threadId');
CREATE INDEX deliveries_pending_by_thread ON deliveries(state, recipient_id, thread_key);
`;
