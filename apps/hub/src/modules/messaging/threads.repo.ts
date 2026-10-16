import type { ThreadKind } from '@agentmesh/protocol';
import type { ThreadRecord } from '../../contracts';
import type { Db } from '../../db/database';

interface ThreadRow {
  id: number;
  kind: ThreadKind;
  subject: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  depth: number;
  parent_id: number | null;
  task_id: number | null;
  plan_id: number | null;
  status: 'open' | 'closed';
  message_count: number;
}

export interface NewThread {
  kind: ThreadKind;
  subject: string;
  createdBy: string;
  depth: number;
  parentId: number | null;
  taskId: number | null;
  planId: number | null;
  at: string;
}

export interface ThreadFilter {
  participant: string | null;
  kind: ThreadKind | null;
  openOnly: boolean;
  limit: number;
}

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    depth: row.depth,
    parentId: row.parent_id,
    taskId: row.task_id,
    planId: row.plan_id,
    status: row.status,
    messageCount: row.message_count,
  };
}

/** Data access for `threads` and `thread_participants`. */
export class ThreadsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(t: NewThread): number {
    return this.#db.run(
      `INSERT INTO threads (kind, subject, created_by, created_at, updated_at, depth, parent_id,
         task_id, plan_id)
       VALUES ($kind, $subject, $createdBy, $at, $at, $depth, $parentId, $taskId, $planId)`,
      { ...t },
    ).lastInsertRowid;
  }

  get(id: number): ThreadRecord | undefined {
    const row = this.#db.get<ThreadRow>('SELECT * FROM threads WHERE id = $id', { id });
    return row ? toRecord(row) : undefined;
  }

  addParticipants(threadId: number, ids: readonly string[], at: string): void {
    for (const id of ids) {
      this.#db.run(
        `INSERT OR IGNORE INTO thread_participants (thread_id, participant_id, joined_at)
         VALUES ($threadId, $id, $at)`,
        { threadId, id, at },
      );
    }
  }

  /** Participants in the order they joined. */
  participants(threadId: number): string[] {
    return this.participantsOf([threadId]).get(threadId) ?? [];
  }

  participantsOf(threadIds: readonly number[]): Map<number, string[]> {
    const rows = this.#db.all<{ thread_id: number; participant_id: string }>(
      `SELECT thread_id, participant_id FROM thread_participants
       WHERE thread_id IN (SELECT value FROM json_each($ids)) ORDER BY joined_at, rowid`,
      { ids: JSON.stringify(threadIds) },
    );
    const out = new Map<number, string[]>();
    for (const row of rows)
      out.set(row.thread_id, [...(out.get(row.thread_id) ?? []), row.participant_id]);
    return out;
  }

  isParticipant(threadId: number, participantId: string): boolean {
    return (
      this.#db.get(
        'SELECT 1 FROM thread_participants WHERE thread_id = $threadId AND participant_id = $participantId',
        { threadId, participantId },
      ) !== undefined
    );
  }

  recordMessage(threadId: number, at: string): void {
    this.#db.run(
      'UPDATE threads SET updated_at = $at, message_count = message_count + 1 WHERE id = $threadId',
      { threadId, at },
    );
  }

  close(threadId: number, at: string): void {
    this.#db.run("UPDATE threads SET status = 'closed', updated_at = $at WHERE id = $threadId", {
      threadId,
      at,
    });
  }

  link(threadId: number, taskId: number | null, planId: number | null): void {
    this.#db.run(
      `UPDATE threads SET task_id = COALESCE($taskId, task_id), plan_id = COALESCE($planId, plan_id)
       WHERE id = $threadId`,
      { threadId, taskId, planId },
    );
  }

  /** Newest activity first. */
  list(filter: ThreadFilter): ThreadRecord[] {
    return this.#db
      .all<ThreadRow>(
        `SELECT t.* FROM threads t
         WHERE ($participant IS NULL OR EXISTS (SELECT 1 FROM thread_participants tp
                 WHERE tp.thread_id = t.id AND tp.participant_id = $participant))
           AND ($kind IS NULL OR t.kind = $kind)
           AND ($openOnly = 0 OR t.status = 'open')
         ORDER BY t.updated_at DESC, t.id DESC LIMIT $limit`,
        { ...filter, openOnly: filter.openOnly ? 1 : 0 },
      )
      .map(toRecord);
  }

  openCount(): number {
    return (
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads WHERE status = 'open'")?.n ?? 0
    );
  }
}
