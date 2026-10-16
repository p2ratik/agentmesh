import { z } from 'zod';
import { DeclaredStatus, GitPolicy, PeerInfo } from '../primitives';
import { ANY_CALLER, defineMethod } from './define';

export const sessionMethods = {
  'session.hello': defineMethod({
    description: 'Register a connected agent session and fetch team policy.',
    callers: ['agent', 'service'],
    params: z.object({
      clientVersion: z.string(),
      repo: z.string().optional(),
      branch: z.string().optional(),
    }),
    result: z.object({
      self: PeerInfo,
      mesh: z.object({ name: z.string(), prefix: z.string() }),
      policy: z.object({ instructions: z.string(), git: GitPolicy }),
      /** Threads with messages this agent has not read yet (see `inbox.get`). */
      unreadThreads: z.number().int().nonnegative(),
    }),
  }),
  'session.bye': defineMethod({
    description: 'Mark the calling session offline.',
    callers: ['agent', 'service'],
    params: z.object({}),
    result: z.object({ ok: z.literal(true) }),
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
