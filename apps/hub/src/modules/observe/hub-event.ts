import { randomUUID } from 'node:crypto';
import type { HubEvent } from '@agentmesh/protocol';
import type { HubContext } from '../../context';

type Omitted = 'id' | 'at' | 'source' | 'session';
/** A hub event without the fields every one shares. */
export type HubEventFields = HubEvent extends infer E
  ? E extends HubEvent
    ? Omit<E, Omitted>
    : never
  : never;

/** Records one of the hub's own events: ids, stages and codes only, never text. */
export type RecordHub = (agent: string, session: string | null, fields: HubEventFields) => void;

export function recordHub(
  ctx: Pick<HubContext, 'events' | 'clock'>,
  agent: string,
  session: string | null,
  fields: HubEventFields,
): void {
  ctx.events.record(agent, {
    ...fields,
    id: randomUUID(),
    at: ctx.clock.now().toISOString(),
    source: 'hub',
    session,
  } as HubEvent);
}

export const hubRecorder =
  (ctx: Pick<HubContext, 'events' | 'clock'>): RecordHub =>
  (agent, session, fields) =>
    recordHub(ctx, agent, session, fields);
