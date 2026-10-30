import { MeshError } from '@agentmesh/common';
import type { Actor, RpcHandlerMap } from '../../contracts';
import { internalId } from '../../core/ids';
import { peekInbox, readInbox } from './inbox';
import type { MessagingServiceImpl } from './messaging.service';

type ThreadHandlers = Pick<
  RpcHandlerMap,
  'thread.get' | 'thread.list' | 'thread.close' | 'inbox.get' | 'inbox.peek' | 'messages.seen'
>;

/** `me` (or nothing, for agents) means the caller; humans and services default to every thread. */
function listParticipant(requested: string | undefined, actor: Actor): string | null {
  if (requested === 'me') return actor.id;
  if (requested !== undefined) return requested;
  return actor.kind === 'agent' ? actor.id : null;
}

export function threadHandlers(messaging: MessagingServiceImpl): ThreadHandlers {
  return {
    /** The team is trusted: anyone may read any thread. Reading advances a participant's cursor, unless another session owns the thread. */
    'thread.get': (params, call) => {
      const threadId = internalId('thread', params.threadId);
      const thread = messaging.thread(threadId);
      let beforeSeq: number | null = null;
      if (params.beforeId) {
        beforeSeq = messaging.messages.seqOf(threadId, params.beforeId) ?? null;
        if (beforeSeq === null) {
          throw new MeshError('not_found', `Message ${params.beforeId} not found in this thread`);
        }
      }
      const rows = messaging.messages.recent(thread.id, params.limit, beforeSeq);
      const last = rows.at(-1);
      // A session that does not own the thread only looks; the owner has not seen it yet.
      const owner = messaging.ownerOf(thread.id, call.actor.id);
      const mayMarkRead =
        call.session === null || owner === null || owner.sessionId === call.session;
      if (last && mayMarkRead) messaging.reads.advance(thread.id, call.actor.id, last.seq);
      return {
        thread: messaging.summary(thread.id),
        messages: rows.map((row) => messaging.toMessage(row)),
      };
    },
    'thread.list': (params, call) => {
      const threads = messaging.threads.list({
        participant: listParticipant(params.participant, call.actor),
        kind: params.kind ?? null,
        openOnly: params.openOnly,
        limit: params.limit,
      });
      return { threads: messaging.summaries(threads) };
    },
    'thread.close': (params, call) => {
      const threadId = internalId('thread', params.threadId);
      messaging.thread(threadId);
      if (call.actor.kind !== 'human' && !messaging.isParticipant(threadId, call.actor.id)) {
        throw new MeshError('forbidden', 'Only participants or humans may close a thread');
      }
      return messaging.closeThread(threadId, call.actor.id);
    },
    'inbox.get': (params, call) =>
      readInbox(messaging, call.actor.id, call.session, params.limit, params.perThread),
    /** A pull session's poll (ADR 0008): counts only, nothing marked read. */
    'inbox.peek': (_params, call) => peekInbox(messaging, call.actor.id, call.session),
    /** What the plugin showed (status items ride along unread until then). */
    'messages.seen': (params, call) => {
      messaging.markSeen(call.actor.id, params.messageIds);
      return { ok: true };
    },
  };
}
