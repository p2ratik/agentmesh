import type { SQLInputValue } from 'node:sqlite';
import { MeshError } from '@agentmesh/common';
import type { PlanContribution, PlanRound, PlanState, PlanTaskDraft } from '@agentmesh/protocol';
import { planKey } from '../../core/ids';
import { type Db, fromJson, toJson } from '../../db/database';

export interface PlanRecord {
  id: number;
  topic: string;
  state: PlanState;
  template: string;
  initiator: string;
  facilitator: string;
  participants: string[];
  threadId: number;
  rounds: PlanRound[];
  roundIndex: number;
  deadline: string | null;
  requireApproval: boolean;
  facilitatorHandoffs: number;
  summary: string | null;
  drafts: PlanTaskDraft[];
  taskIds: number[];
  createdAt: string;
  updatedAt: string;
}

export type NewPlan = Omit<PlanRecord, 'id' | 'updatedAt' | 'summary' | 'drafts' | 'taskIds'>;

export type PlanPatch = Partial<
  Pick<
    PlanRecord,
    | 'state'
    | 'facilitator'
    | 'roundIndex'
    | 'deadline'
    | 'facilitatorHandoffs'
    | 'summary'
    | 'drafts'
    | 'taskIds'
  >
>;

const COLUMNS: Record<keyof PlanPatch, string> = {
  state: 'state',
  facilitator: 'facilitator',
  roundIndex: 'round_index',
  deadline: 'deadline',
  facilitatorHandoffs: 'facilitator_handoffs',
  summary: 'summary',
  drafts: 'drafts',
  taskIds: 'task_ids',
};

interface PlanRow {
  id: number;
  topic: string;
  state: string;
  template: string;
  initiator: string;
  facilitator: string;
  participants: string;
  thread_id: number;
  rounds: string;
  round_index: number;
  deadline: string | null;
  require_approval: number;
  facilitator_handoffs: number;
  summary: string | null;
  drafts: string;
  task_ids: string;
  created_at: string;
  updated_at: string;
}

/** `plans` and `plan_contributions`. */
export class PlansRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(plan: NewPlan): number {
    return this.#db.run(
      `INSERT INTO plans (topic, state, template, initiator, facilitator, participants, thread_id,
         rounds, round_index, deadline, require_approval, facilitator_handoffs, created_at, updated_at)
       VALUES ($topic, $state, $template, $initiator, $facilitator, $participants, $threadId,
         $rounds, $roundIndex, $deadline, $requireApproval, $facilitatorHandoffs, $createdAt, $createdAt)`,
      {
        ...plan,
        participants: toJson(plan.participants),
        rounds: toJson(plan.rounds),
        requireApproval: plan.requireApproval ? 1 : 0,
      },
    ).lastInsertRowid;
  }

  require(id: number): PlanRecord {
    const row = this.#db.get<PlanRow>('SELECT * FROM plans WHERE id = $id', { id });
    if (!row) throw new MeshError('not_found', `Plan ${planKey(id)} not found`);
    return fromRow(row);
  }

  update(id: number, patch: PlanPatch, at: string): void {
    const params: Record<string, SQLInputValue> = { id, at };
    const sets = ['updated_at = $at'];
    for (const [key, value] of Object.entries(patch) as Array<[keyof PlanPatch, unknown]>) {
      if (value === undefined) continue;
      sets.push(`${COLUMNS[key]} = $${key}`);
      params[key] = Array.isArray(value) ? toJson(value) : (value as SQLInputValue);
    }
    this.#db.run(`UPDATE plans SET ${sets.join(', ')} WHERE id = $id`, params);
  }

  list(states: readonly PlanState[] | null, limit: number): PlanRecord[] {
    return this.#db
      .all<PlanRow>(
        `SELECT * FROM plans
         WHERE ($states IS NULL OR state IN (SELECT value FROM json_each($states)))
         ORDER BY id DESC LIMIT $limit`,
        { states: states ? toJson(states) : null, limit },
      )
      .map(fromRow);
  }

  /** Plans whose deadline passed while a round or the synthesis was running. */
  due(now: string): PlanRecord[] {
    return this.#db
      .all<PlanRow>(
        `SELECT * FROM plans WHERE state IN ('collecting', 'synthesizing')
           AND deadline IS NOT NULL AND deadline <= $now ORDER BY id`,
        { now },
      )
      .map(fromRow);
  }

  countIn(states: readonly PlanState[]): number {
    return (
      this.#db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM plans WHERE state IN (SELECT value FROM json_each($states))',
        { states: toJson(states) },
      )?.n ?? 0
    );
  }

  addContribution(planId: number, c: Omit<PlanContribution, 'planId'>): void {
    this.#db.run(
      `INSERT INTO plan_contributions (plan_id, round, participant_id, body, created_at)
       VALUES ($planId, $round, $participant, $body, $createdAt)`,
      { planId, ...c },
    );
  }

  contributions(planId: number, round?: string): PlanContribution[] {
    return this.#db
      .all<{ round: string; participant_id: string; body: string; created_at: string }>(
        `SELECT round, participant_id, body, created_at FROM plan_contributions
         WHERE plan_id = $planId AND ($round IS NULL OR round = $round) ORDER BY id`,
        { planId, round: round ?? null },
      )
      .map((r) => ({
        planId: planKey(planId),
        round: r.round,
        participant: r.participant_id,
        body: r.body,
        createdAt: r.created_at,
      }));
  }
}

function fromRow(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    topic: row.topic,
    state: row.state as PlanState,
    template: row.template,
    initiator: row.initiator,
    facilitator: row.facilitator,
    participants: fromJson<string[]>(row.participants, []),
    threadId: row.thread_id,
    rounds: fromJson<PlanRound[]>(row.rounds, []),
    roundIndex: row.round_index,
    deadline: row.deadline,
    requireApproval: row.require_approval === 1,
    facilitatorHandoffs: row.facilitator_handoffs,
    summary: row.summary,
    drafts: fromJson<PlanTaskDraft[]>(row.drafts, []),
    taskIds: fromJson<number[]>(row.task_ids, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
