import { MeshError } from '@agentmesh/common';
import type { HubEvent, ObservedEvent, ReportedEvent } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { EventSink } from '../../contracts';
import { EventsRepo } from './events.repo';
import { formatTimeline } from './timeline';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const UNIT_MS = { m: MINUTE_MS, h: 3_600_000, d: DAY_MS } as const;

/** An ISO time, or `<n>m|h|d` before `now`, as an ISO string comparable with stored times. */
function parseWhen(value: string, name: 'since' | 'until', now: Date): string {
  const rel = /^(\d{1,4})([mhd])$/.exec(value);
  if (rel)
    return new Date(
      now.getTime() - Number(rel[1]) * UNIT_MS[rel[2] as 'm' | 'h' | 'd'],
    ).toISOString();
  const ms = /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new MeshError(
      'invalid_request',
      `${name} must be an ISO time or a duration like 30m, 2h, 1d`,
    );
  }
  return new Date(ms).toISOString();
}

export interface TimelineParams {
  agent?: string;
  session?: string;
  thread?: string;
  since: string;
  until?: string;
  kinds?: readonly string[];
  limit: number;
}

export class ObserveService {
  readonly #repo: EventsRepo;
  /** Receive times (ms) of each agent's stored events in the last minute. In memory. */
  readonly #recent = new Map<string, number[]>();

  /** `ownsSession`: whether the agent has this (non-closed) session; the sessions module answers. */
  constructor(
    private readonly ctx: Pick<HubContext, 'db' | 'clock' | 'loaded' | 'index'>,
    private readonly ownsSession: (agent: string, session: string) => boolean,
  ) {
    this.#repo = new EventsRepo(ctx.db);
  }

  /** How many agents have budget entries (for tests: it must not grow forever). */
  get trackedAgents(): number {
    return this.#recent.size;
  }

  /** Stores what `agent` (proven by NATS) reported. Any `agent` inside an event is ignored. */
  report(agent: string, events: ReportedEvent[]): { accepted: number; dropped: number } {
    const { enabled, maxEventsPerMinute } = this.ctx.loaded.config.observability;
    if (!enabled) throw new MeshError('forbidden', 'observability is turned off on this hub');
    const nowMs = this.ctx.clock.now().getTime();
    const receivedAt = new Date(nowMs).toISOString();
    const recent = (this.#recent.get(agent) ?? []).filter((t) => nowMs - t < MINUTE_MS);
    const owned = new Map<string, boolean>();
    const mine = (session: string) => {
      if (!owned.has(session)) owned.set(session, this.ownsSession(agent, session));
      return owned.get(session);
    };
    let accepted = 0;
    let dropped = 0;
    for (const event of events) {
      if (recent.length >= maxEventsPerMinute) {
        dropped += 1;
        continue;
      }
      // A session that is not the caller's own is not recorded, so nobody can pin events on another's.
      const stored = event.session && !mine(event.session) ? { ...event, session: null } : event;
      // A resent event counts as accepted (the plugin stops retrying) and still takes budget.
      this.#repo.insert(agent, stored, receivedAt);
      recent.push(nowMs);
      accepted += 1;
    }
    if (recent.length) this.#recent.set(agent, recent);
    else this.#recent.delete(agent);
    return { accepted, dropped };
  }

  /** The newest events first (up to `limit`). */
  query(filter: Parameters<EventsRepo['query']>[0]): ObservedEvent[] {
    return this.#repo.query(filter);
  }

  /** Operators only: the caller agent's owner must be in `observability.viewers`. */
  timeline(
    callerAgent: string,
    p: TimelineParams,
  ): { events: ObservedEvent[]; text: string; truncated: boolean } {
    const owner = this.ctx.index.agent(callerAgent)?.owner;
    if (!owner || !this.ctx.loaded.config.observability.viewers.includes(owner)) {
      throw new MeshError('forbidden', "the timeline is for this mesh's operators only");
    }
    const now = this.ctx.clock.now();
    const since = parseWhen(p.since, 'since', now);
    const until = p.until === undefined ? undefined : parseWhen(p.until, 'until', now);
    const found = this.#repo.query({ ...p, since, until, limit: p.limit + 1 });
    const events = found.slice(0, p.limit).reverse();
    const truncated = found.length > p.limit;
    const title = /^\d{1,4}[mhd]$/.test(p.since) ? `last ${p.since}` : `since ${since}`;
    return {
      events,
      text: formatTimeline(events, { title, truncated, limit: p.limit }),
      truncated,
    };
  }

  prune(now: Date): number {
    const { retentionDays } = this.ctx.loaded.config.observability;
    return this.#repo.prune(new Date(now.getTime() - retentionDays * DAY_MS).toISOString());
  }
}

/** The hub's own events into the same store. Off when observability is off; never throws. */
export function createEventSink(
  ctx: Pick<HubContext, 'db' | 'clock' | 'loaded' | 'logger'>,
): EventSink {
  const repo = new EventsRepo(ctx.db);
  return {
    record(agent, event: HubEvent) {
      try {
        if (!ctx.loaded.config.observability.enabled) return;
        repo.insert(agent, event, ctx.clock.now().toISOString());
      } catch (err) {
        ctx.logger.debug({ err, kind: event.kind }, 'could not record an event');
      }
    },
  };
}
