import { z } from 'zod';
import { DeclaredStatus, GitPolicy, PeerInfo, SessionId } from '../primitives';
import { SessionView } from '../sessions';
import { ANY_CALLER, defineMethod } from './define';

export const sessionMethods = {
  'session.hello': defineMethod({
    description: 'Register a connected agent session and fetch team policy.',
    callers: ['agent', 'service'],
    params: z.object({
      clientVersion: z.string(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      /** This process's session before a reconnect: reused if still open, else reclaimed from. */
      previousSessionId: z.string().optional(),
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
  'session.activate': defineMethod({
    description: 'Make this session the one that receives work, with a short description.',
    callers: ['agent'],
    params: z.object({ description: z.string().min(1).max(200) }),
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
      .object({ threadId: z.string().optional(), taskId: z.string().optional() })
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
      repo: z.string().optional(),
      branch: z.string().optional(),
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
