import { z } from 'zod';
import { MeshMessage, ReplyStatus, SendableKind, ThreadKind, ThreadSummary } from '../messages';
import { ANY_CALLER, defineMethod, PARTICIPANTS } from './define';

const Recipients = z
  .array(z.string().min(1))
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
        threadId: z.string().optional(),
        /** Thread that caused this one; drives loop protection. */
        parentThreadId: z.string().optional(),
        subject: z.string().max(200).optional(),
        status: ReplyStatus.optional(),
        prUrl: z.string().max(500).optional(),
        taskId: z.string().optional(),
        toSession: z.string().optional(),
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
      threadId: z.string(),
      limit: z.number().int().min(1).max(200).default(50),
      beforeId: z.string().optional(),
    }),
    result: z.object({ thread: ThreadSummary, messages: z.array(MeshMessage) }),
  }),
  'thread.list': defineMethod({
    description: 'List threads, newest activity first.',
    callers: ANY_CALLER,
    params: z.object({
      participant: z.string().optional(),
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
  'thread.close': defineMethod({
    description: 'Close a conversation thread you participate in.',
    callers: PARTICIPANTS,
    params: z.object({ threadId: z.string() }),
    result: ThreadSummary,
  }),
  escalate: defineMethod({
    description: 'Ask a human (your owner by default) a question; they are pinged in Discord.',
    callers: ['agent'],
    params: z.object({
      question: z.string().min(1).max(8000),
      to: z.string().optional(),
      threadId: z.string().optional(),
      taskId: z.string().optional(),
      urgent: z.boolean().default(false),
    }),
    result: z.object({ threadId: z.string(), messageId: z.string() }),
  }),
} as const;
