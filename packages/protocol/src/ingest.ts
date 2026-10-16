import { z } from 'zod';
import { IsoDate, Severity } from './primitives';

/**
 * An event from outside the team: CI, monitoring, error tracking, cron jobs.
 * Producers (e.g. a Hermes bot) send this over HTTP or publish it to NATS.
 */
export const IngestEvent = z.object({
  /** Producer-side id; repeated ids inside the dedup window are dropped. */
  id: z.string().min(1).max(200).optional(),
  type: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9_.:-]+$/, 'letters, digits, and _ . : -'),
  occurredAt: IsoDate.optional(),
  severity: Severity.default('info'),
  summary: z.string().max(2000).optional(),
  url: z.string().max(2000).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type IngestEventInput = z.input<typeof IngestEvent>;
export type IngestEvent = z.output<typeof IngestEvent>;

export const StoredIngestEvent = IngestEvent.extend({
  id: z.string(),
  source: z.string(),
  receivedAt: IsoDate,
});
export type StoredIngestEvent = z.infer<typeof StoredIngestEvent>;
