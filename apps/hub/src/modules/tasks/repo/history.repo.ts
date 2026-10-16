import type { TaskHistoryEntry } from '@agentmesh/protocol';
import type { Db } from '../../../db/database';

/** Append-only audit trail of task transitions (`task_history`). */
export class HistoryRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  add(taskId: number, entry: TaskHistoryEntry): void {
    this.#db.run(
      `INSERT INTO task_history (task_id, at, actor, action, from_state, to_state, note)
       VALUES ($taskId, $at, $actor, $action, $from, $to, $note)`,
      { taskId, ...entry },
    );
  }

  list(taskId: number): TaskHistoryEntry[] {
    return this.#db
      .all<{
        at: string;
        actor: string;
        action: string;
        from_state: string | null;
        to_state: string;
        note: string | null;
      }>(
        `SELECT at, actor, action, from_state, to_state, note FROM task_history
         WHERE task_id = $taskId ORDER BY id`,
        { taskId },
      )
      .map((r) => ({
        at: r.at,
        actor: r.actor,
        action: r.action,
        from: r.from_state,
        to: r.to_state,
        note: r.note,
      }));
  }
}
