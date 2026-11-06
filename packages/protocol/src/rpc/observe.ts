import { z } from 'zod';
import { ObservedEvent, ReportedEvent } from '../observe';
import { HUB_KINDS, REPORTED_KINDS } from '../observe-codes';
import { ParticipantId, SessionId } from '../primitives';
import { defineMethod } from './define';

export const MAX_REPORT_EVENTS = 100;
export const MAX_TIMELINE_EVENTS = 2000;

/** An ISO time or a relative duration back from now (`30m`, `2h`, `1d`); the hub parses it. */
const When = z.string().max(40);

export const observeMethods = {
  'telemetry.report': defineMethod({
    description: "Ship a batch of this session's behaviour events (ids, counts and codes only).",
    callers: ['agent'],
    params: z.object({ events: z.array(ReportedEvent).max(MAX_REPORT_EVENTS) }),
    result: z.object({
      accepted: z.number().int().nonnegative(),
      dropped: z.number().int().nonnegative(),
    }),
  }),
  'observe.timeline': defineMethod({
    description: 'Read the event timeline. Only humans listed in observability.viewers may.',
    callers: ['agent'],
    params: z.object({
      agent: ParticipantId.optional(),
      session: SessionId.optional(),
      thread: z
        .string()
        .regex(/^thr-\d{1,12}$/)
        .optional(),
      since: When.default('2h'),
      until: When.optional(),
      kinds: z
        .array(z.enum([...REPORTED_KINDS, ...HUB_KINDS]))
        .max(20)
        .optional(),
      limit: z.number().int().min(1).max(MAX_TIMELINE_EVENTS).default(500),
    }),
    result: z.object({
      events: z.array(ObservedEvent),
      text: z.string(),
      truncated: z.boolean(),
    }),
  }),
} as const;
