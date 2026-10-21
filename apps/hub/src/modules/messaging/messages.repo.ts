import type { MessageKind, ReplyStatus, Trust } from '@agentmesh/protocol';
import type { Db } from '../../db/database';

/** A stored message joined with its thread's subject. */
export interface MessageRow {
  seq: number;
  id: string;
  thread_id: number;
  sender_id: string;
  kind: MessageKind;
  body: string;
  status: ReplyStatus | null;
  trust: Trust;
  depth: number;
  recipients: string;
  refs: string;
  created_at: string;
  subject: string;
}

export interface NewMessage {
  id: string;
  threadId: number;
  senderId: string;
  kind: MessageKind;
  body: string;
  bodyHash: string;
  status: ReplyStatus | null;
  trust: Trust;
  depth: number;
  recipients: string;
  refs: string;
  at: string;
}

/** Every message read joins its thread for the subject. */
export const MESSAGE_SELECT =
  'SELECT m.*, t.subject AS subject FROM messages m JOIN threads t ON t.id = m.thread_id';

/** Data access for `messages`. */
export class MessagesRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(m: NewMessage): number {
    return this.#db.run(
      `INSERT INTO messages (id, thread_id, sender_id, kind, body, body_hash, status, trust, depth,
         recipients, refs, created_at)
       VALUES ($id, $threadId, $senderId, $kind, $body, $bodyHash, $status, $trust, $depth,
         $recipients, $refs, $at)`,
      { ...m },
    ).lastInsertRowid;
  }

  bySeq(seq: number): MessageRow | undefined {
    return this.#db.get<MessageRow>(`${MESSAGE_SELECT} WHERE m.seq = $seq`, { seq });
  }

  position(messageId: string): { threadId: number; seq: number } | undefined {
    return this.#db.get<{ threadId: number; seq: number }>(
      'SELECT thread_id AS threadId, seq FROM messages WHERE id = $messageId',
      { messageId },
    );
  }

  seqOf(threadId: number, messageId: string): number | undefined {
    return this.#db.get<{ seq: number }>(
      'SELECT seq FROM messages WHERE thread_id = $threadId AND id = $messageId',
      { threadId, messageId },
    )?.seq;
  }

  /** The `limit` newest messages (before `beforeSeq` if given), oldest first. */
  recent(threadId: number, limit: number, beforeSeq: number | null): MessageRow[] {
    return this.#db
      .all<MessageRow>(
        `${MESSAGE_SELECT} WHERE m.thread_id = $threadId AND ($beforeSeq IS NULL OR m.seq < $beforeSeq)
         ORDER BY m.seq DESC LIMIT $limit`,
        { threadId, limit, beforeSeq },
      )
      .reverse();
  }

  maxSeq(threadId: number): number {
    return (
      this.#db.get<{ n: number | null }>(
        'SELECT MAX(seq) AS n FROM messages WHERE thread_id = $threadId',
        { threadId },
      )?.n ?? 0
    );
  }

  countInThreadSince(threadId: number, since: string, excludeSender: string): number {
    return (
      this.#db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages
         WHERE thread_id = $threadId AND created_at >= $since AND sender_id <> $excludeSender`,
        { threadId, since, excludeSender },
      )?.n ?? 0
    );
  }

  countBySenderSince(senderId: string, since: string): number {
    return (
      this.#db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM messages WHERE sender_id = $senderId AND created_at >= $since',
        { senderId, since },
      )?.n ?? 0
    );
  }

  hasDuplicate(threadId: number, senderId: string, bodyHash: string, since: string): boolean {
    return (
      this.#db.get(
        `SELECT 1 FROM messages WHERE thread_id = $threadId AND sender_id = $senderId
           AND body_hash = $bodyHash AND created_at >= $since LIMIT 1`,
        { threadId, senderId, bodyHash, since },
      ) !== undefined
    );
  }
}
