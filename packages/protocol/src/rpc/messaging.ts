import { z } from 'zod';
import { MeshMessage, ReplyStatus, SendableKind, ThreadKind, ThreadSummary } from '../messages';
import { IdRef } from '../primitives';
import { ANY_CALLER, defineMethod, PARTICIPANTS } from './define';

/** Most sender ids an `inbox.peek` names. */
export const MAX_PEEK_SENDERS = 5;

const Recipients = z
  .array(IdRef.min(1))
  .min(1)
  .max(50)
  .describe('Participant ids, or the special targets "@all" / "@online" (agents only).');

export const messagingMethods = {
  'message.send': defineMethod({
    description:
      'Start a thread (pass `to`) or post into one (pass `threadId`). Posting into a thread ' +
      'delivers to every participant except the sender; `to` also adds participants.',
    callers: PARTICIPANTS,
    params: z
      .object({
        kind: SendableKind,
        body: z.string().min(1).max(32_000),
        to: Recipients.optional(),
        threadId: IdRef.optional(),
        /** Thread that caused this one; drives loop protection. */
        parentThreadId: IdRef.optional(),
        subject: z.string().max(200).optional(),
        status: ReplyStatus.optional(),
        prUrl: z.string().max(500).optional(),
        taskId: IdRef.optional(),
        toSession: IdRef.optional(),
        repo: z.string().max(200).optional(),
      })
      .refine((p) => p.to !== undefined || p.threadId !== undefined, {
        message: 'Pass `to` to start a thread or `threadId` to reply in one.',
      }),
    result: z.object({
      messageId: z.string(),
      threadId: z.string(),
      deliveredTo: z.array(z.string()),
      held: z.boolean(),
    }),
  }),
  'thread.get': defineMethod({
    description: 'Fetch a thread and its most recent messages (oldest first).',
    callers: ANY_CALLER,
    params: z.object({
      threadId: IdRef,
      limit: z.number().int().min(1).max(200).default(50),
      beforeId: IdRef.optional(),
    }),
    result: z.object({ thread: ThreadSummary, messages: z.array(MeshMessage) }),
  }),
  'thread.list': defineMethod({
    description: 'List threads, newest activity first.',
    callers: ANY_CALLER,
    params: z.object({
      participant: IdRef.optional(),
      kind: ThreadKind.optional(),
      openOnly: z.boolean().default(true),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    result: z.object({ threads: z.array(ThreadSummary) }),
  }),
  'inbox.get': defineMethod({
    description:
      'Threads with messages you have not seen yet, with those messages. Returning them marks ' +
      'them read. Channel pushes are best-effort, so this is the source of truth.',
    callers: ['agent'],
    params: z.object({
      limit: z.number().int().min(1).max(50).default(20),
      perThread: z.number().int().min(1).max(20).default(5),
    }),
    result: z.object({
      threads: z.array(
        z.object({
          thread: ThreadSummary,
          unread: z.number().int().nonnegative(),
          messages: z.array(MeshMessage),
          /** True when every unread message in the thread is status for the caller. */
          fyi: z.boolean().default(false),
        }),
      ),
      remainingThreads: z.number().int().nonnegative(),
      /** Unread threads owned by the agent's other sessions (left unread here), for `take`. */
      otherSessions: z
        .array(
          z.object({
            threadId: z.string(),
            sessionId: z.string(),
            liveness: z.enum(['live', 'away']),
          }),
        )
        .default([]),
    }),
  }),
  'inbox.peek': defineMethod({
    description:
      'Counts what `inbox.get` would return for this session, without marking anything read: ' +
      'unread threads, how many need action, recent senders and whether any is external.',
    callers: ['agent'],
    params: z.object({}),
    result: z.object({
      threads: z.number().int().nonnegative(),
      /** Threads with an unread action item (the rest are FYI only). */
      actions: z.number().int().nonnegative(),
      /** Distinct sender ids of the unread messages, newest first. */
      from: z.array(z.string()).max(MAX_PEEK_SENDERS),
      external: z.boolean(),
    }),
  }),
  'messages.seen': defineMethod({
    description: 'Mark messages you have read (e.g. FYI items shown in a session) as seen.',
    callers: ['agent'],
    params: z.object({ messageIds: z.array(IdRef).min(1).max(500) }),
    result: z.object({ ok: z.literal(true) }),
  }),
  'thread.close': defineMethod({
    description: 'Close a conversation thread you participate in.',
    callers: PARTICIPANTS,
    params: z.object({ threadId: IdRef }),
    result: ThreadSummary,
  }),
  escalate: defineMethod({
    description: 'Ask a human (your owner by default) a question; they are pinged in Discord.',
    callers: ['agent'],
    params: z.object({
      question: z.string().min(1).max(8000),
      to: IdRef.optional(),
      threadId: IdRef.optional(),
      taskId: IdRef.optional(),
      urgent: z.boolean().default(false),
    }),
    result: z.object({ threadId: z.string(), messageId: z.string() }),
  }),
} as const;
