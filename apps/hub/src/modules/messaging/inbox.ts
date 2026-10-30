import { MAX_PEEK_SENDERS, type RpcResult } from '@agentmesh/protocol';
import { threadKey } from '../../core/ids';
import type { MessagingServiceImpl } from './messaging.service';
import type { UnreadThread } from './reads.repo';

type OtherSession = RpcResult<'inbox.get'>['otherSessions'][number];

/**
 * The participant's unread threads this session may read: its own and unowned
 * ones, in `unreadThreads` order. Threads owned by the agent's other sessions are
 * only named (`otherSessions`) and stay unread. Without a session, every thread.
 */
function selectUnread(
  messaging: MessagingServiceImpl,
  participantId: string,
  sessionId: string | null,
): { unread: UnreadThread[]; otherSessions: OtherSession[] } {
  const otherSessions: OtherSession[] = [];
  const unread = messaging.reads.unreadThreads(participantId).filter((entry) => {
    const owner = messaging.ownerOf(entry.threadId, participantId);
    if (sessionId === null || owner === null || owner.sessionId === sessionId) return true;
    otherSessions.push({ threadId: threadKey(entry.threadId), ...owner });
    return false;
  });
  return { unread, otherSessions };
}

/**
 * Unread threads for a participant: those needing it first, then FYI ones
 * (every unread message is status), each group most recent first. Each has its
 * unread count and newest `perThread` unread messages. Returned threads are marked
 * read up to their latest message; the rest stay unread for the next call.
 */
export function readInbox(
  messaging: MessagingServiceImpl,
  participantId: string,
  sessionId: string | null,
  limit: number,
  perThread: number,
): RpcResult<'inbox.get'> {
  return messaging.ctx.db.transaction(() => {
    const { unread, otherSessions } = selectUnread(messaging, participantId, sessionId);
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

/** What `readInbox` would return for this session, as counts and sender ids; marks nothing read. */
export function peekInbox(
  messaging: MessagingServiceImpl,
  participantId: string,
  sessionId: string | null,
): RpcResult<'inbox.peek'> {
  const { unread } = selectUnread(messaging, participantId, sessionId);
  const mine = new Set(unread.map((entry) => entry.threadId));
  const senders = messaging.reads.unreadSenders(participantId).filter((s) => mine.has(s.threadId));
  return {
    threads: unread.length,
    actions: unread.filter((entry) => entry.actions > 0).length,
    from: [...new Set(senders.map((s) => s.senderId))].slice(0, MAX_PEEK_SENDERS),
    external: senders.some((s) => s.external === 1),
  };
}
