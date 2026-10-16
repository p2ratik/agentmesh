import { z } from 'zod';
import { IsoDate } from './primitives';

/** Advisory lock on a path glob, so two agents do not edit the same area at once. */
export const Lease = z.object({
  id: z.string(),
  holder: z.string(),
  repo: z.string().nullable(),
  path: z.string(),
  reason: z.string().nullable(),
  taskId: z.string().nullable(),
  expiresAt: IsoDate,
  createdAt: IsoDate,
});
export type Lease = z.infer<typeof Lease>;

export const LeaseConflict = z.object({
  requested: z.string(),
  held: z.string(),
  holder: z.string(),
  expiresAt: IsoDate,
});
export type LeaseConflict = z.infer<typeof LeaseConflict>;
