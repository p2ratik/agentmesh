import type { Db } from '../../../db/database';

/** Rows of `task_dependencies`: `taskId` waits for `dependsOn`. */
export class DependenciesRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  add(taskId: number, dependsOn: readonly number[]): void {
    for (const dep of dependsOn) {
      this.#db.run(
        'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES ($taskId, $dep)',
        { taskId, dep },
      );
    }
  }

  /** Tasks this one waits for. */
  dependsOn(taskId: number): number[] {
    return this.#db
      .all<{ depends_on: number }>(
        'SELECT depends_on FROM task_dependencies WHERE task_id = $taskId ORDER BY depends_on',
        { taskId },
      )
      .map((r) => r.depends_on);
  }

  /** Tasks waiting for this one. */
  dependents(taskId: number): number[] {
    return this.#db
      .all<{ task_id: number }>(
        'SELECT task_id FROM task_dependencies WHERE depends_on = $taskId ORDER BY task_id',
        { taskId },
      )
      .map((r) => r.task_id);
  }
}
