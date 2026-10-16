import type { Lease } from '@agentmesh/protocol';
import { optionalKey } from '../../core/ids';
import type { Db } from '../../db/database';

interface LeaseRow {
  id: number;
  holder: string;
  repo: string | null;
  path: string;
  reason: string | null;
  task_id: number | null;
  created_at: string;
  expires_at: string;
}

export interface NewLease {
  holder: string;
  repo: string | null;
  path: string;
  reason: string | null;
  taskId: number | null;
  createdAt: string;
  expiresAt: string;
}

/** Rows of the `leases` table. Only unexpired rows are ever returned. */
export class LeasesRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  active(now: string, filter: { holder?: string | null; repo?: string | null } = {}): Lease[] {
    return this.#db
      .all<LeaseRow>(
        `SELECT * FROM leases WHERE expires_at > $now
           AND ($holder IS NULL OR holder = $holder)
           AND ($repo IS NULL OR repo IS NULL OR lower(repo) = lower($repo))
         ORDER BY id`,
        { now, holder: filter.holder ?? null, repo: filter.repo ?? null },
      )
      .map(toLease);
  }

  /** Re-leasing the same path (same holder, same repo) extends it instead of duplicating it. */
  upsert(lease: NewLease): Lease {
    const existing = this.#db.get<{ id: number }>(
      `SELECT id FROM leases WHERE holder = $holder AND path = $path
         AND ((repo IS NULL AND $repo IS NULL) OR repo = $repo)`,
      { holder: lease.holder, path: lease.path, repo: lease.repo },
    );
    if (existing) {
      this.#db.run(
        `UPDATE leases SET expires_at = $expiresAt, reason = $reason, task_id = $taskId
         WHERE id = $id`,
        { id: existing.id, expiresAt: lease.expiresAt, reason: lease.reason, taskId: lease.taskId },
      );
      return this.#get(existing.id);
    }
    const { lastInsertRowid } = this.#db.run(
      `INSERT INTO leases (holder, repo, path, reason, task_id, created_at, expires_at)
       VALUES ($holder, $repo, $path, $reason, $taskId, $createdAt, $expiresAt)`,
      { ...lease },
    );
    return this.#get(lastInsertRowid);
  }

  release(holder: string, paths: readonly string[] | null): number {
    if (paths === null) {
      return this.#db.run('DELETE FROM leases WHERE holder = $holder', { holder }).changes;
    }
    let released = 0;
    for (const path of paths) {
      released += this.#db.run('DELETE FROM leases WHERE holder = $holder AND path = $path', {
        holder,
        path,
      }).changes;
    }
    return released;
  }

  releaseForTask(taskId: number): number {
    return this.#db.run('DELETE FROM leases WHERE task_id = $taskId', { taskId }).changes;
  }

  purgeExpired(now: string): number {
    return this.#db.run('DELETE FROM leases WHERE expires_at <= $now', { now }).changes;
  }

  #get(id: number): Lease {
    const row = this.#db.get<LeaseRow>('SELECT * FROM leases WHERE id = $id', { id });
    if (!row) throw new Error(`lease ${id} vanished`);
    return toLease(row);
  }
}

function toLease(row: LeaseRow): Lease {
  return {
    id: `lease-${row.id}`,
    holder: row.holder,
    repo: row.repo,
    path: row.path,
    reason: row.reason,
    taskId: optionalKey('task', row.task_id),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
