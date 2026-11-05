import type { Db } from '../../db/database';

/** A closed asker's answer waiting for the owner's decision. */
export interface OrphanRow {
  thread_id: number;
  agent_id: string;
  released_by: string;
  due_at: string;
  escalated_at: string | null;
}

/** Data access for `orphan_decisions`. No business rules. */
export class OrphansRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Starts a thread's decision timer; false when it already has one. */
  insertOrphan(threadId: number, agentId: string, releasedBy: string, dueAt: string): boolean {
    const { changes } = this.#db.run(
      `INSERT OR IGNORE INTO orphan_decisions (thread_id, agent_id, released_by, due_at)
       VALUES ($threadId, $agentId, $releasedBy, $dueAt)`,
      { threadId, agentId, releasedBy, dueAt },
    );
    return changes > 0;
  }

  /** Decisions due at `at` (ISO), escalated ones included, earliest first. */
  dueOrphans(at: string): OrphanRow[] {
    return this.#db.all<OrphanRow>(
      'SELECT * FROM orphan_decisions WHERE due_at <= $at ORDER BY due_at',
      { at },
    );
  }

  /** Stamps `escalated_at` once; an earlier stamp stays. */
  markOrphanEscalated(threadId: number, agentId: string, at: string): void {
    this.#db.run(
      `UPDATE orphan_decisions SET escalated_at = $at
       WHERE thread_id = $threadId AND agent_id = $agentId AND escalated_at IS NULL`,
      { threadId, agentId, at },
    );
  }

  deleteOrphan(threadId: number, agentId: string): void {
    this.#db.run(
      'DELETE FROM orphan_decisions WHERE thread_id = $threadId AND agent_id = $agentId',
      { threadId, agentId },
    );
  }
}
