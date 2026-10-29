import { z } from 'zod';
import { Lease, LeaseConflict } from '../leases';
import { GitRef, IdRef } from '../primitives';
import { ANY_CALLER, defineMethod } from './define';

export const leaseMethods = {
  'lease.acquire': defineMethod({
    description:
      'Take advisory leases on path globs before editing a shared area. All-or-nothing: on any ' +
      'conflict nothing is granted and the conflicts are returned.',
    callers: ['agent'],
    params: z.object({
      paths: z.array(z.string().min(1).max(300)).min(1).max(50),
      repo: GitRef.optional(),
      ttlMinutes: z
        .number()
        .positive()
        .max(7 * 24 * 60)
        .optional(),
      reason: z.string().max(500).optional(),
      taskId: IdRef.optional(),
    }),
    result: z.object({ granted: z.array(Lease), conflicts: z.array(LeaseConflict) }),
  }),
  'lease.release': defineMethod({
    description: 'Release some of your leases, or all of them.',
    callers: ['agent'],
    params: z.object({
      paths: z.array(z.string().max(300)).max(200).optional(),
      all: z.boolean().default(false),
    }),
    result: z.object({ released: z.number().int().nonnegative() }),
  }),
  'lease.list': defineMethod({
    description: 'List active leases, optionally for one holder or repo.',
    callers: ANY_CALLER,
    params: z.object({ holder: IdRef.optional(), repo: GitRef.optional() }),
    result: z.object({ leases: z.array(Lease) }),
  }),
} as const;
