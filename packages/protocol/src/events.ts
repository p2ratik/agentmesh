import { z } from 'zod';
import { MemberRecord } from './enrollment';
import { StoredIngestEvent } from './ingest';
import { MeshMessage, ThreadSummary } from './messages';
import { Plan, PlanState } from './planning';
import { IsoDate, PeerInfo, Severity } from './primitives';
import { Task } from './tasks';

/**
 * The activity feed. The hub publishes one of these for every state change;
 * bridges (Discord today, Slack or a web UI tomorrow) render them.
 */
const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ id: z.string(), type: z.literal(type), at: IsoDate, data });

export const DomainEvent = z.discriminatedUnion('type', [
  event('message.created', z.object({ message: MeshMessage, thread: ThreadSummary })),
  event('thread.created', z.object({ thread: ThreadSummary })),
  event('task.created', z.object({ task: Task })),
  event(
    'task.changed',
    z.object({
      task: Task,
      action: z.string(),
      from: z.string().nullable(),
      to: z.string(),
      actor: z.string(),
      note: z.string().nullable(),
    }),
  ),
  event('plan.started', z.object({ plan: Plan })),
  event(
    'plan.changed',
    z.object({
      plan: Plan,
      from: PlanState,
      to: PlanState,
      round: z.string().nullable(),
    }),
  ),
  event(
    'external.received',
    z.object({ event: StoredIngestEvent, matchedRules: z.array(z.string()) }),
  ),
  event(
    'notice.posted',
    z.object({
      /** Channel purpose from config (e.g. `alerts`), not a platform channel id. */
      channel: z.string(),
      text: z.string(),
      severity: Severity,
    }),
  ),
  event('mesh.paused', z.object({ by: z.string(), reason: z.string().nullable() })),
  event('mesh.resumed', z.object({ by: z.string(), released: z.number().int() })),
  event('presence.changed', z.object({ peer: PeerInfo })),
  event('member.joined', z.object({ member: MemberRecord })),
  event('member.removed', z.object({ member: MemberRecord, by: z.string() })),
]);

export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventType = DomainEvent['type'];
export type DomainEventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
export type DomainEventData<T extends DomainEventType> = DomainEventOf<T>['data'];
