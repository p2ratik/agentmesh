/**
 * The mesh window (plan 2): one session per teammate started by the launcher takes the
 * team's unowned work. Set at hello, never changed (a process keeps its marker).
 */
export const MIGRATION_007 = `
ALTER TABLE sessions ADD COLUMN mesh_window INTEGER NOT NULL DEFAULT 0
  CHECK (mesh_window IN (0, 1));
`;
