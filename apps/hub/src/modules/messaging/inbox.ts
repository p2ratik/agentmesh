import type { RpcResult } from '@agentmesh/protocol';
import { threadKey } from '../../core/ids';
import type { MessagingServiceImpl } from './messaging.service';

type OtherSession = RpcResult<'inbox.get'>['otherSessions'][number];

/**
 * Unread threads for a participant: those needing it first, then FYI ones
 * (every unread message is status), each group most recent first. Each has its
 * unread count and newest `perThread` unread messages. Returned threads are marked
 * read up to their latest message; the rest stay unread for the next call.
 * A session sees its own threads and unowned ones; threads owned by the
 * agent's other sessions are only named (`otherSessions`) and stay unread.
 */
export function readInbox(
  messaging: MessagingServiceImpl,
  participantId: string,
  sessionId: string | null,
  limit: number,
  perThread: number,
): RpcResult<'inbox.get'> {
  return messaging.ctx.db.transaction(() => {
    const otherSessions: OtherSession[] = [];
    const unread = messaging.reads.unreadThreads(participantId).filter((entry) => {
      const owner = messaging.ownerOf(entry.threadId, participantId);
      if (sessionId === null || owner === null || owner.sessionId === sessionId) return true;
      otherSessions.push({ threadId: threadKey(entry.threadId), ...owner });
      return false;
    });
    const picked = unread.slice(0, limit);
    const threads = picked.map((entry) => {
      const messages = messaging.reads
        .unreadMessages(entry.threadId, participantId, perThread)
        .map((row) => messaging.toMessage(row));
      messaging.reads.advance(
        entry.threadId,
        participantId,
        messaging.messages.maxSeq(entry.threadId),
      );
      return {
        thread: messaging.summary(entry.threadId),
        unread: entry.unread,
        messages,
        fyi: entry.actions === 0,
      };
    });
    return { threads, remainingThreads: unread.length - picked.length, otherSessions };
  });
}
