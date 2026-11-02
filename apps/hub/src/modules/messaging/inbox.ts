import { MAX_PEEK_SENDERS, type RpcResult } from '@agentmesh/protocol';
import { threadKey } from '../../core/ids';
import type { MessagingServiceImpl } from './messaging.service';
import type { UnreadThread } from './reads.repo';

type OtherSession = RpcResult<'inbox.get'>['otherSessions'][number];

/** Sessionless callers may take anything; a session only if the hub says so. */
export function mayTakeUnowned(
  messaging: MessagingServiceImpl,
  participantId: string,
  sessionId: string | null,
): boolean {
  return sessionId === null || messaging.deps.mayTakeUnowned(participantId, sessionId);
}

/**
 * The participant's unread threads this session may read: its own and the unowned
 * ones it may take (the rest only count as `waiting`), in `unreadThreads` order. Threads owned by the agent's other sessions are
 * only named (`otherSessions`) and stay unread. Without a session, every thread.
 */
function selectUnread(
  messaging: MessagingServiceImpl,
  participantId: string,
  sessionId: string | null,
): { unread: UnreadThread[]; otherSessions: OtherSession[]; waiting: number } {
  const otherSessions: OtherSession[] = [];
  let waiting = 0;
  const mayTake = mayTakeUnowned(messaging, participantId, sessionId);
  const unread = messaging.reads.unreadThreads(participantId).filter((entry) => {
    const owner = messaging.ownerOf(entry.threadId, participantId);
    if (sessionId === null || owner?.sessionId === sessionId) return true;
    if (owner === null) {
      if (mayTake) return true;
      waiting += 1;
      return false;
    }
    otherSessions.push({ threadId: threadKey(entry.threadId), ...owner });
    return false;
  });
  return { unread, otherSessions, waiting };
}

/**
 * Unread threads for a participant: those needing it first, then FYI ones
 * (every unread message is status), each group most recent first. Each has its
 * unread count and newest `perThread` unread messages. Returned threads are marked
 * read up to their latest message; the rest stay unread for the next call. While the
 * mesh is paused nothing is marked read and the result says `paused: true`.
 */
export function readInbox(
  messaging: MessagingServiceImpl,
  participantId: string,
  sessionId: string | null,
  limit: number,
  perThread: number,
): RpcResult<'inbox.get'> {
  return messaging.ctx.db.transaction(() => {
    const { unread, otherSessions, waiting } = selectUnread(messaging, participantId, sessionId);
    const paused = messaging.deps.control.isPaused();
    const picked = unread.slice(0, limit);
    const threads = picked.map((entry) => {
      const messages = messaging.reads
        .unreadMessages(entry.threadId, participantId, perThread)
        .map((row) => messaging.toMessage(row));
      if (!paused) {
        messaging.reads.advance(
          entry.threadId,
          participantId,
          messaging.messages.maxSeq(entry.threadId),
        );
      }
      return {
        thread: messaging.summary(entry.threadId),
        unread: entry.unread,
        messages,
        fyi: entry.actions === 0,
      };
    });
    return {
      threads,
      remainingThreads: unread.length - picked.length,
      otherSessions,
      waiting,
      paused,
    };
  });
}

/** What `readInbox` would return for this session, as counts and sender ids; marks nothing read. */
export function peekInbox(
  messaging: MessagingServiceImpl,
  participantId: string,
  sessionId: string | null,
): RpcResult<'inbox.peek'> {
  const { unread, waiting } = selectUnread(messaging, participantId, sessionId);
  const mine = new Set(unread.map((entry) => entry.threadId));
  const senders = messaging.reads.unreadSenders(participantId).filter((s) => mine.has(s.threadId));
  return {
    threads: unread.length,
    actions: unread.filter((entry) => entry.actions > 0).length,
    from: [...new Set(senders.map((s) => s.senderId))].slice(0, MAX_PEEK_SENDERS),
    external: senders.some((s) => s.external === 1),
    waiting,
  };
}
