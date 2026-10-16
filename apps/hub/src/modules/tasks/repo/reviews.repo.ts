import type { ReviewVerdict, TaskReview } from '@agentmesh/protocol';
import type { Db } from '../../../db/database';

/**
 * Reviewers per round (`task_reviewers`) and submitted reviews (`task_reviews`).
 * Round 0 holds reviewers pinned at creation (e.g. `review.request` with explicit
 * reviewers); real review rounds start at 1.
 */
export class ReviewsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  reviewers(taskId: number, round: number): string[] {
    return this.#db
      .all<{ reviewer_id: string }>(
        `SELECT reviewer_id FROM task_reviewers WHERE task_id = $taskId AND round = $round
         ORDER BY rowid`,
        { taskId, round },
      )
      .map((r) => r.reviewer_id);
  }

  addReviewers(taskId: number, round: number, reviewerIds: readonly string[]): void {
    for (const reviewerId of reviewerIds) {
      this.#db.run(
        `INSERT OR IGNORE INTO task_reviewers (task_id, reviewer_id, round)
         VALUES ($taskId, $reviewerId, $round)`,
        { taskId, reviewerId, round },
      );
    }
  }

  add(taskId: number, review: TaskReview): void {
    this.#db.run(
      `INSERT INTO task_reviews (task_id, reviewer_id, verdict, body, round, created_at)
       VALUES ($taskId, $reviewer, $verdict, $body, $round, $createdAt)`,
      { taskId, ...review },
    );
  }

  /** Every review of a task, oldest first; `round` narrows to one round. */
  list(taskId: number, round?: number): TaskReview[] {
    return this.#db
      .all<{
        reviewer_id: string;
        verdict: string;
        body: string;
        round: number;
        created_at: string;
      }>(
        `SELECT reviewer_id, verdict, body, round, created_at FROM task_reviews
         WHERE task_id = $taskId AND ($round IS NULL OR round = $round) ORDER BY id`,
        { taskId, round: round ?? null },
      )
      .map((r) => ({
        reviewer: r.reviewer_id,
        verdict: r.verdict as ReviewVerdict,
        body: r.body,
        round: r.round,
        createdAt: r.created_at,
      }));
  }
}
