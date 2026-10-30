import { z } from 'zod';
import {
  DeclaredStatus,
  DeliveryMode,
  GitPolicy,
  GitRef,
  IdRef,
  PeerInfo,
  SessionId,
} from '../primitives';
import { SessionView } from '../sessions';
import { ANY_CALLER, defineMethod } from './define';

export const sessionMethods = {
  'session.hello': defineMethod({
    description: 'Register a connected agent session and fetch team policy.',
    callers: ['agent', 'service'],
    params: z.object({
      clientVersion: z.string().max(32),
      repo: GitRef.optional(),
      branch: GitRef.optional(),
      /** This process's session before a reconnect: reused if still open, else reclaimed from. */
      previousSessionId: SessionId.optional(),
    }),
    result: z.object({
      self: PeerInfo,
      mesh: z.object({ name: z.string(), prefix: z.string() }),
      policy: z.object({ instructions: z.string(), git: GitPolicy }),
      /** Threads with messages this agent has not read yet (see `inbox.get`). */
      unreadThreads: z.number().int().nonnegative(),
      /** The hub-issued id this session sends on every call. */
      sessionId: SessionId,
      /** Thread keys taken back from the previous session because nobody else took them. */
      reclaimed: z.array(z.string()),
    }),
  }),
  'session.bye': defineMethod({
    description: 'Mark the calling session offline.',
    callers: ['agent', 'service'],
    params: z.object({}),
    result: z.object({ ok: z.literal(true) }),
  }),
  'session.check': defineMethod({
    description:
      'Send this session a test message with an activation code, over its session subject.',
    callers: ['agent'],
    params: z.object({}),
    result: z.object({ ok: z.literal(true) }),
  }),
  'session.activate': defineMethod({
    description:
      'Make this session one that receives work: the code from its check and a short description. ' +
      'In `pull` mode (no channel flag) no code is needed and nothing is pushed: it reads with inbox.',
    callers: ['agent'],
    params: z
      .object({
        mode: DeliveryMode.default('push'),
        code: z.string().min(1).max(20).optional(),
        description: z.string().min(1).max(200),
      })
      .refine((p) => p.mode === 'pull' || p.code !== undefined, {
        message: 'Pass the code from the test message, or mode "pull".',
      }),
    result: SessionView,
  }),
  'session.deactivate': defineMethod({
    description: 'Stop receiving work in this session.',
    callers: ['agent'],
    params: z.object({}),
    result: SessionView,
  }),
  'session.describe': defineMethod({
    description: 'Change this session description.',
    callers: ['agent'],
    params: z.object({ description: z.string().min(1).max(200) }),
    result: SessionView,
  }),
  'session.take': defineMethod({
    description: 'Take over a thread or task from the session that owns it.',
    callers: ['agent'],
    params: z
      .object({ threadId: IdRef.optional(), taskId: IdRef.optional() })
      .refine((p) => (p.threadId === undefined) !== (p.taskId === undefined), {
        message: 'Pass exactly one of `threadId` and `taskId`.',
      }),
    result: z.object({ threadId: z.string(), previousSession: z.string().nullable() }),
  }),
  'presence.set': defineMethod({
    description: 'Declare your status (online, busy, away) with an optional note.',
    callers: ['agent'],
    params: z.object({
      status: DeclaredStatus,
      note: z.string().max(200).optional(),
      repo: GitRef.optional(),
      branch: GitRef.optional(),
    }),
    result: PeerInfo,
  }),
  'peers.list': defineMethod({
    description: 'List every participant with presence and current load.',
    callers: ANY_CALLER,
    params: z.object({ kind: z.enum(['agent', 'human', 'all']).default('all') }),
    result: z.object({ peers: z.array(PeerInfo) }),
  }),
} as const;
