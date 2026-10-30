import type { Db } from '../../db/database';
import { MESSAGE_SELECT, type MessageRow } from './messages.repo';

/**
 * A message is unread for P when P participates in its thread, it is past P's
 * read cursor, P did not send it, and P is one of its recipients.
 */
const UNREAD = `
  JOIN thread_participants tp ON tp.thread_id = m.thread_id AND tp.participant_id = $p
  WHERE m.seq > tp.last_read_seq AND m.sender_id <> $p
    AND EXISTS (SELECT 1 FROM json_each(m.recipients) r WHERE r.value = $p)`;

/** The message is status for P (P is listed in its `status_for`). */
const STATUS = 'EXISTS (SELECT 1 FROM json_each(m.status_for) s WHERE s.value = $p)';

export interface UnreadThread {
  threadId: number;
  unread: number;
  /** Unread messages that are action for the participant; the rest are status. */
  actions: number;
  lastSeq: number;
}

/** Per-participant read cursors (`thread_participants.last_read_seq`). */
export class ReadsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Moves the cursor forward only; a no-op for non-participants. */
  advance(threadId: number, participantId: string, seq: number): void {
    this.#db.run(
      `UPDATE thread_participants SET last_read_seq = MAX(last_read_seq, $seq)
       WHERE thread_id = $threadId AND participant_id = $participantId`,
      { threadId, participantId, seq },
    );
  }

  /** The participant's read cursor in the thread; null for non-participants. */
  cursor(threadId: number, participantId: string): number | null {
    return (
      this.#db.get<{ seq: number }>(
        `SELECT last_read_seq AS seq FROM thread_participants
         WHERE thread_id = $threadId AND participant_id = $participantId`,
        { threadId, participantId },
      )?.seq ?? null
    );
  }

  /** Threads with unread messages: any with an action first, then status-only; newest first. */
  unreadThreads(participantId: string): UnreadThread[] {
    return this.#db.all<UnreadThread>(
      `SELECT m.thread_id AS threadId, COUNT(*) AS unread, MAX(m.seq) AS lastSeq,
         SUM(NOT ${STATUS}) AS actions
       FROM messages m ${UNREAD}
       GROUP BY m.thread_id ORDER BY actions = 0, lastSeq DESC`,
      { p: participantId },
    );
  }

  /** Per unread thread and sender: whether any of it is external (0/1). Newest first. */
  unreadSenders(
    participantId: string,
  ): Array<{ threadId: number; senderId: string; external: number }> {
    return this.#db.all(
      `SELECT m.thread_id AS threadId, m.sender_id AS senderId, MAX(m.seq) AS lastSeq,
         MAX(m.trust = 'external') AS external
       FROM messages m ${UNREAD}
       GROUP BY m.thread_id, m.sender_id ORDER BY lastSeq DESC`,
      { p: participantId },
    );
  }

  unreadThreadCount(participantId: string): number {
    return (
      this.#db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT m.thread_id) AS n FROM messages m ${UNREAD}`,
        { p: participantId },
      )?.n ?? 0
    );
  }

  /** The newest `limit` unread messages of a thread, oldest first. */
  unreadMessages(threadId: number, participantId: string, limit: number): MessageRow[] {
    return this.#db
      .all<MessageRow>(
        `${MESSAGE_SELECT} ${UNREAD} AND m.thread_id = $threadId ORDER BY m.seq DESC LIMIT $limit`,
        { p: participantId, threadId, limit },
      )
      .reverse();
  }

  /** The seq of the participant's oldest unread action in the thread; null when there is none. */
  oldestUnreadAction(threadId: number, participantId: string): number | null {
    return (
      this.#db.get<{ seq: number | null }>(
        `SELECT MIN(m.seq) AS seq FROM messages m ${UNREAD} AND m.thread_id = $threadId
           AND NOT ${STATUS}`,
        { p: participantId, threadId },
      )?.seq ?? null
    );
  }

  /** The newest `limit` unread status items of a thread before `beforeSeq`, oldest first. */
  unreadStatus(
    threadId: number,
    participantId: string,
    beforeSeq: number,
    limit: number,
  ): MessageRow[] {
    return this.#db
      .all<MessageRow>(
        `${MESSAGE_SELECT} ${UNREAD} AND m.thread_id = $threadId AND ${STATUS}
           AND m.seq < $beforeSeq
         ORDER BY m.seq DESC LIMIT $limit`,
        { p: participantId, threadId, beforeSeq, limit },
      )
      .reverse();
  }
}
