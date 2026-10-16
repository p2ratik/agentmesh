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

export interface UnreadThread {
  threadId: number;
  unread: number;
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

  /** Threads with unread messages, most recent unread first. */
  unreadThreads(participantId: string): UnreadThread[] {
    return this.#db.all<UnreadThread>(
      `SELECT m.thread_id AS threadId, COUNT(*) AS unread, MAX(m.seq) AS lastSeq
       FROM messages m ${UNREAD}
       GROUP BY m.thread_id ORDER BY lastSeq DESC`,
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
}
