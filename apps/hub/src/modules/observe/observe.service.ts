import { MeshError } from '@agentmesh/common';
import {
  type HubEvent,
  OBSERVABILITY_OFF,
  type ObservedEvent,
  type ReportedEvent,
} from '@agentmesh/protocol';
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

/**
 * Each key's receive times (ms) in the last minute, in memory: what it may still store under a
 * per-minute budget. A key whose window is empty is forgotten.
 */
class MinuteWindow {
  readonly #recent = new Map<string, number[]>();

  get size(): number {
    return this.#recent.size;
  }

  /** Takes up to `wanted` of `max` a minute for `key` at `nowMs`; returns how many it got. */
  take(key: string, nowMs: number, max: number, wanted: number): number {
    const recent = (this.#recent.get(key) ?? []).filter((t) => nowMs - t < MINUTE_MS);
    const granted = Math.max(0, Math.min(wanted, max - recent.length));
    for (let i = 0; i < granted; i++) recent.push(nowMs);
    if (recent.length) this.#recent.set(key, recent);
    else this.#recent.delete(key);
    return granted;
  }
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
  /** Each agent's stored reports in the last minute. */
  readonly #budget = new MinuteWindow();

  /** `ownsSession`: whether the agent has this (non-closed) session; the sessions module answers. */
  constructor(
    private readonly ctx: Pick<HubContext, 'db' | 'clock' | 'loaded' | 'index'>,
    private readonly ownsSession: (agent: string, session: string) => boolean,
  ) {
    this.#repo = new EventsRepo(ctx.db);
  }

  /** How many agents have budget entries (for tests: it must not grow forever). */
  get trackedAgents(): number {
    return this.#budget.size;
  }

  /** Stores what `agent` (proven by NATS) reported. Any `agent` inside an event is ignored. */
  report(agent: string, events: ReportedEvent[]): { accepted: number; dropped: number } {
    const { enabled, maxEventsPerMinute } = this.ctx.loaded.config.observability;
    if (!enabled) throw new MeshError('forbidden', OBSERVABILITY_OFF);
    const nowMs = this.ctx.clock.now().getTime();
    const receivedAt = new Date(nowMs).toISOString();
    // A resent event counts as accepted (the plugin stops retrying) and still takes budget.
    const room = this.#budget.take(agent, nowMs, maxEventsPerMinute, events.length);
    const owned = new Map<string, boolean>();
    const mine = (session: string) => {
      if (!owned.has(session)) owned.set(session, this.ownsSession(agent, session));
      return owned.get(session);
    };
    for (const event of events.slice(0, room)) {
      // A session that is not the caller's own is not recorded, so nobody can pin events on another's.
      const stored = event.session && !mine(event.session) ? { ...event, session: null } : event;
      this.#repo.insert(agent, stored, receivedAt);
    }
    return { accepted: room, dropped: events.length - room };
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

/** The callout's refusals name no agent, so they share one budget. */
const UNAUTHENTICATED = '(unauthenticated)';

/**
 * The hub's own events into the same store. Off when observability is off; never throws. A
 * caller's failed calls (`rpc`, per caller) and the callout's refusals (`auth`, one shared budget)
 * are capped at `maxEventsPerMinute` like reports, so a loop or an unauthenticated flood cannot
 * grow the table without bound; the hub's session, delivery, relay and orphan events are not.
 */
export function createEventSink(
  ctx: Pick<HubContext, 'db' | 'clock' | 'loaded' | 'logger'>,
): EventSink {
  const repo = new EventsRepo(ctx.db);
  const budget = new MinuteWindow();
  /** Budgets that have filled once: the first time warns, later drops log at debug. */
  const full = new Set<string>();
  return {
    record(agent, event: HubEvent) {
      try {
        const { enabled, maxEventsPerMinute } = ctx.loaded.config.observability;
        if (!enabled) return;
        const now = ctx.clock.now();
        const key = event.kind === 'auth' ? UNAUTHENTICATED : event.kind === 'rpc' ? agent : null;
        if (key !== null && budget.take(key, now.getTime(), maxEventsPerMinute, 1) === 0) {
          const level = full.has(key) ? 'debug' : 'warn';
          full.add(key);
          ctx.logger[level](
            { budget: key, kind: event.kind },
            'hub events over the per-minute cap; not recorded',
          );
          return;
        }
        repo.insert(agent, event, now.toISOString());
      } catch (err) {
        ctx.logger.debug({ err, kind: event.kind }, 'could not record an event');
      }
    },
  };
}
