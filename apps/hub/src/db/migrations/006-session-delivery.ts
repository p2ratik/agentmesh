/**
 * Pull mode (ADR 0008): how work reaches an active session. `push` sessions get
 * channel deliveries; `pull` sessions (no channel flag, e.g. Claude Desktop) are
 * never delivered to and read their messages with `inbox`.
 */
export const MIGRATION_006 = `
ALTER TABLE sessions ADD COLUMN delivery TEXT NOT NULL DEFAULT 'push'
  CHECK (delivery IN ('push', 'pull'));
`;
