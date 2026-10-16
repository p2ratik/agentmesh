import type { SQLInputValue } from 'node:sqlite';
import { MeshError } from '@agentmesh/common';
import type { Priority, Trust } from '@agentmesh/protocol';
import { taskKey } from '../../../core/ids';
import { type Db, fromJson, toJson } from '../../../db/database';

/** A task as stored, with JSON columns decoded and camelCase names. */
export interface TaskRecord {
  id: number;
  title: string;
  description: string;
  workflow: string;
  state: string;
  priority: Priority;
  labels: string[];
  repo: string | null;
  area: string | null;
  baseBranch: string | null;
  branch: string | null;
  prUrl: string | null;
  doneWhen: string | null;
  assignee: string | null;
  createdBy: string;
  planId: number | null;
  threadId: number;
  reviewRound: number;
  declinedBy: string[];
  trust: Trust;
  createdAt: string;
  updatedAt: string;
}

export type NewTask = Omit<TaskRecord, 'id' | 'updatedAt'>;

/** Fields that transitions and effects may change after creation. */
export type TaskPatch = Partial<
  Pick<TaskRecord, 'state' | 'assignee' | 'branch' | 'prUrl' | 'reviewRound' | 'declinedBy'>
>;

const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  state: 'state',
  assignee: 'assignee',
  branch: 'branch',
  prUrl: 'pr_url',
  reviewRound: 'review_round',
  declinedBy: 'declined_by',
};

/** Filters for `list`. `excludeStates` holds `workflow:state` keys (terminal states). */
export interface TaskListFilter {
  assignee: string | null;
  unassigned: boolean;
  states: string[] | null;
  area: string | null;
  planId: number | null;
  excludeStates: string[];
  limit: number;
}

interface TaskRow {
  id: number;
  title: string;
  description: string;
  workflow: string;
  state: string;
  priority: string;
  labels: string;
  repo: string | null;
  area: string | null;
  base_branch: string | null;
  branch: string | null;
  pr_url: string | null;
  done_when: string | null;
  assignee: string | null;
  created_by: string;
  plan_id: number | null;
  thread_id: number;
  review_round: number;
  declined_by: string;
  trust: string;
  created_at: string;
  updated_at: string;
}

const NOT_EXCLUDED = `(workflow || ':' || state) NOT IN (SELECT value FROM json_each($exclude))`;

/** Rows of the `tasks` table. */
export class TasksRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(task: NewTask): number {
    const { lastInsertRowid } = this.#db.run(
      `INSERT INTO tasks (title, description, workflow, state, priority, labels, repo, area,
         base_branch, branch, pr_url, done_when, assignee, created_by, plan_id, thread_id,
         review_round, declined_by, trust, created_at, updated_at)
       VALUES ($title, $description, $workflow, $state, $priority, $labels, $repo, $area,
         $baseBranch, $branch, $prUrl, $doneWhen, $assignee, $createdBy, $planId, $threadId,
         $reviewRound, $declinedBy, $trust, $createdAt, $createdAt)`,
      { ...task, labels: toJson(task.labels), declinedBy: toJson(task.declinedBy) },
    );
    return lastInsertRowid;
  }

  get(id: number): TaskRecord | undefined {
    const row = this.#db.get<TaskRow>('SELECT * FROM tasks WHERE id = $id', { id });
    return row ? fromRow(row) : undefined;
  }

  require(id: number): TaskRecord {
    const task = this.get(id);
    if (!task) throw new MeshError('not_found', `Task ${taskKey(id)} not found`);
    return task;
  }

  update(id: number, patch: TaskPatch, at: string): void {
    const params: Record<string, SQLInputValue> = { id, at };
    const sets = ['updated_at = $at'];
    for (const [key, value] of Object.entries(patch) as Array<[keyof TaskPatch, unknown]>) {
      if (value === undefined) continue;
      sets.push(`${PATCH_COLUMNS[key]} = $${key}`);
      params[key] = Array.isArray(value) ? toJson(value) : (value as SQLInputValue);
    }
    this.#db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $id`, params);
  }

  list(filter: TaskListFilter): TaskRecord[] {
    const rows = this.#db.all<TaskRow>(
      `SELECT * FROM tasks
       WHERE ($assignee IS NULL OR assignee = $assignee)
         AND ($unassigned = 0 OR assignee IS NULL)
         AND ($states IS NULL OR state IN (SELECT value FROM json_each($states)))
         AND ($area IS NULL OR area = $area)
         AND ($planId IS NULL OR plan_id = $planId)
         AND ${NOT_EXCLUDED}
       ORDER BY updated_at DESC, id DESC
       LIMIT $limit`,
      {
        assignee: filter.assignee,
        unassigned: filter.unassigned ? 1 : 0,
        states: filter.states ? toJson(filter.states) : null,
        area: filter.area,
        planId: filter.planId,
        exclude: toJson(filter.excludeStates),
        limit: filter.limit,
      },
    );
    return rows.map(fromRow);
  }

  /** Non-excluded (i.e. non-terminal) tasks per assignee. */
  loadByAssignee(excludeStates: string[]): Map<string, number> {
    const rows = this.#db.all<{ assignee: string; n: number }>(
      `SELECT assignee, COUNT(*) AS n FROM tasks
       WHERE assignee IS NOT NULL AND ${NOT_EXCLUDED} GROUP BY assignee`,
      { exclude: toJson(excludeStates) },
    );
    return new Map(rows.map((r) => [r.assignee, r.n]));
  }

  count(excludeStates: string[]): number {
    return (
      this.#db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE ${NOT_EXCLUDED}`, {
        exclude: toJson(excludeStates),
      })?.n ?? 0
    );
  }
}

function fromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    workflow: row.workflow,
    state: row.state,
    priority: row.priority as Priority,
    labels: fromJson<string[]>(row.labels, []),
    repo: row.repo,
    area: row.area,
    baseBranch: row.base_branch,
    branch: row.branch,
    prUrl: row.pr_url,
    doneWhen: row.done_when,
    assignee: row.assignee,
    createdBy: row.created_by,
    planId: row.plan_id,
    threadId: row.thread_id,
    reviewRound: row.review_round,
    declinedBy: fromJson<string[]>(row.declined_by, []),
    trust: row.trust as Trust,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
