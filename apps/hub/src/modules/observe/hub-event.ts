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

const HOUR_MS = 3_600_000;
/** The most (stage, message, session) keys remembered; the oldest go first. */
const REPEATS_CAP = 10_000;

/** The key of a stage a stuck message repeats on every flush (a `sent`, a `failed`), else null. */
function repeatKey(session: string | null, f: HubEventFields): string | null {
  if (f.kind === 'delivery' && (f.stage === 'sent' || f.stage === 'failed'))
    return `${f.stage}:${f.code ?? ''}:${f.message}:${session}`;
  if (f.kind === 'relay' && f.stage === 'sent') return `relay:${f.message}:${session}`;
  return null;
}

/**
 * The dispatcher's recorder. A message its session never acks, or whose relay the window never
 * answers, goes again on every flush: its `sent` (and `failed`) is recorded at most once per
 * message and session an hour, so a stuck or hostile plugin can't add a row per flush.
 */
export function hubRecorder(ctx: Pick<HubContext, 'events' | 'clock'>): RecordHub {
  const recent = new Map<string, number>();
  return (agent, session, fields) => {
    const key = repeatKey(session, fields);
    if (key !== null) {
      const now = ctx.clock.now().getTime();
      const last = recent.get(key);
      if (last !== undefined && now - last < HOUR_MS) return;
      recent.delete(key);
      recent.set(key, now);
      // ponytail: capped, not swept: an hour-old key ages out by size or on its next repeat.
      if (recent.size > REPEATS_CAP) recent.delete(recent.keys().next().value ?? '');
    }
    recordHub(ctx, agent, session, fields);
  };
}
