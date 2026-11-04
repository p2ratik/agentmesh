import { MINUTE_MS } from '@agentmesh/common';
import type { HubContext } from '../../context';
import type { MessagingService } from '../../contracts';
import { threadKey } from '../../core/ids';
import type { SessionsRepo } from './sessions.repo';

interface OrphanRow {
  thread_id: number;
  agent_id: string;
  released_by: string;
  due_at: string;
}

/**
 * Answers whose private asker closed (spec part B). The mesh window took the answer unclaimed and
 * its human decides: continue it there, reopen the asker, or drop it. One row per thread and
 * agent: the first ack posts one notice in the thread, and after
 * `relay.closedAskerEscalationMinutes` the tick pings the owner there, unless the thread was owned
 * or closed since.
 */
export class OrphanDecisions {
  readonly #ctx: HubContext;
  readonly #repo: SessionsRepo;
  readonly #messaging: MessagingService;

  constructor(ctx: HubContext, repo: SessionsRepo, messaging: MessagingService) {
    this.#ctx = ctx;
    this.#repo = repo;
    this.#messaging = messaging;
  }

  /** Starts the owner's timer for the thread; only the call that starts it posts the notice. */
  record(agentId: string, threadId: number, releasedBy: string): void {
    const dueAt = new Date(this.#ctx.clock.now().getTime() + this.#minutes() * MINUTE_MS);
    const { changes } = this.#ctx.db.run(
      `INSERT OR IGNORE INTO orphan_decisions (thread_id, agent_id, released_by, due_at)
       VALUES ($threadId, $agentId, $releasedBy, $dueAt)`,
      { threadId, agentId, releasedBy, dueAt: dueAt.toISOString() },
    );
    if (changes === 0) return;
    this.#messaging.post({
      threadId,
      senderId: this.#messaging.hubId,
      kind: 'system',
      system: true,
      deliveryClass: 'status',
      body: `The session that asked this has closed; the follow-up waits for ${this.#ownerName(agentId)}'s decision.`,
    });
  }

  /** Settles every due row, each in its own transaction; returns how many escalated. */
  tick(now: Date): number {
    const due = this.#ctx.db.all<OrphanRow>(
      'SELECT * FROM orphan_decisions WHERE due_at <= $now ORDER BY due_at',
      { now: now.toISOString() },
    );
    let escalated = 0;
    for (const row of due) if (this.#ctx.db.transaction(() => this.#settle(row))) escalated += 1;
    return escalated;
  }

  /** Stops the timers of these threads (their asker took them back). */
  forget(agentId: string, threadIds: readonly number[]): void {
    for (const threadId of threadIds) this.#delete(agentId, threadId);
  }

  /** Deletes the row, and pings the owner in the thread unless it was owned or closed since. */
  #settle({ thread_id: threadId, agent_id: agent }: OrphanRow): boolean {
    this.#delete(agent, threadId);
    if (this.#repo.owner(threadId, agent) !== null) return false;
    if (this.#messaging.thread(threadId).status === 'closed') return false;
    const { index, logger } = this.#ctx;
    const owner = index.agent(agent)?.owner;
    if (!owner) return false;
    const log = { agent, owner, thread: threadKey(threadId) };
    if (!index.human(owner)?.discordUserId) {
      logger.warn(log, 'closed-asker escalation pings nobody: no Discord account mapped');
    }
    this.#messaging.post({
      threadId,
      senderId: this.#messaging.hubId,
      kind: 'escalation',
      status: 'needs_human',
      system: true,
      to: [owner],
      body:
        `The session that asked this has closed, and its answer has waited ${this.#minutes()} ` +
        `minutes for ${this.#ownerName(agent)}'s decision: continue it in the mesh window, ` +
        'reopen that session, or drop it. Reply here or in the mesh window.',
    });
    logger.info(log, 'closed-asker decision escalated');
    return true;
  }

  #delete(agentId: string, threadId: number): void {
    this.#ctx.db.run(
      'DELETE FROM orphan_decisions WHERE thread_id = $threadId AND agent_id = $agentId',
      { threadId, agentId },
    );
  }

  #minutes(): number {
    return this.#ctx.loaded.config.relay.closedAskerEscalationMinutes;
  }

  #ownerName(agentId: string): string {
    const { index } = this.#ctx;
    return index.displayName(index.agent(agentId)?.owner ?? agentId);
  }
}
