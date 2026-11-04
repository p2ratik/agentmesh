import { MINUTE_MS } from '@agentmesh/common';
import type { HubContext } from '../../context';
import type { MessagingService } from '../../contracts';
import { threadKey } from '../../core/ids';
import type { OrphanRow, SessionsRepo } from './sessions.repo';

/**
 * Answers whose private asker closed (spec part B). The mesh window took the answer unclaimed and
 * its human decides: continue it there, reopen the asker, or drop it. One row per thread and
 * agent, kept until the thread is owned or closed, so a closed asker gets one notice and one
 * escalation: the first ack posts the notice in the thread, and after
 * `relay.closedAskerEscalationMinutes` the tick pings the owner there once. The owner's own reply
 * is the decision: it starts no timer and settles a running one.
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

  /**
   * Starts the owner's timer for a thread that is still unowned (the window may have taken it
   * since the send); only the call that starts it posts the notice.
   */
  record(agentId: string, threadId: number, releasedBy: string): void {
    if (this.#repo.owner(threadId, agentId) !== null) return;
    const dueAt = new Date(this.#ctx.clock.now().getTime() + this.#minutes() * MINUTE_MS);
    if (!this.#repo.insertOrphan(threadId, agentId, releasedBy, dueAt.toISOString())) return;
    this.#messaging.post({
      threadId,
      senderId: this.#messaging.hubId,
      kind: 'system',
      system: true,
      deliveryClass: 'status',
      body: `The session that asked this has closed; the follow-up waits for ${this.#ownerName(agentId)}'s decision.`,
    });
  }

  /** The owner answered in the thread: a running timer is settled without a ping. */
  answered(agentId: string, threadId: number): void {
    this.#repo.markOrphanEscalated(threadId, agentId, this.#ctx.clock.now().toISOString());
  }

  /** Settles every due row, each in its own transaction; returns how many escalated. */
  tick(now: Date): number {
    // ponytail: escalated rows are rechecked each tick until their thread is owned or closed; a
    // cheaper sweep if abandoned orphan threads ever pile up.
    const at = now.toISOString();
    let escalated = 0;
    for (const row of this.#repo.dueOrphans(at)) {
      try {
        if (this.#ctx.db.transaction(() => this.#settle(row, at))) escalated += 1;
      } catch (err) {
        const log = { err, thread: threadKey(row.thread_id), agent: row.agent_id };
        this.#ctx.logger.error(log, 'closed-asker decision failed; the next tick tries again');
      }
    }
    return escalated;
  }

  /** Stops the timers of these threads (their asker took them back). */
  forget(agentId: string, threadIds: readonly number[]): void {
    for (const threadId of threadIds) this.#repo.deleteOrphan(threadId, agentId);
  }

  /**
   * Deletes the row once its thread is owned or closed. Otherwise marks it escalated, then pings
   * the owner in the thread; a row already escalated (or answered) is left as it is.
   */
  #settle(row: OrphanRow, at: string): boolean {
    const { thread_id: threadId, agent_id: agent } = row;
    const owned = this.#repo.owner(threadId, agent) !== null;
    if (owned || this.#messaging.thread(threadId).status === 'closed') {
      this.#repo.deleteOrphan(threadId, agent);
      return false;
    }
    if (row.escalated_at !== null) return false;
    this.#repo.markOrphanEscalated(threadId, agent, at);
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

  #minutes(): number {
    return this.#ctx.loaded.config.relay.closedAskerEscalationMinutes;
  }

  #ownerName(agentId: string): string {
    const { index } = this.#ctx;
    return index.displayName(index.agent(agentId)?.owner ?? agentId);
  }
}
