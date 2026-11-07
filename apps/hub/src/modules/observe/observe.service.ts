import { MeshError } from '@agentmesh/common';
import {
  HubEvent,
  OBSERVABILITY_OFF,
  type ObservedEvent,
  ParticipantId,
  ReportedEvent,
} from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { EventSink } from '../../contracts';
import { EventsRepo } from './events.repo';
import { fitTimeline } from './timeline';

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

  /**
   * Stores what `agent` (proven by NATS) reported, in one transaction. Each event is checked on its
   * own, so one a newer plugin knows and this hub doesn't costs only itself: it counts as dropped.
   * The strict schema refuses an `agent` field, so the caller is the only attribution.
   */
  report(agent: string, events: readonly unknown[]): { accepted: number; dropped: number } {
    const { enabled, maxEventsPerMinute } = this.ctx.loaded.config.observability;
    if (!enabled) throw new MeshError('forbidden', OBSERVABILITY_OFF);
    const valid = events.flatMap((e): ReportedEvent[] => {
      const parsed = ReportedEvent.safeParse(e);
      return parsed.success ? [parsed.data] : [];
    });
    const nowMs = this.ctx.clock.now().getTime();
    const receivedAt = new Date(nowMs).toISOString();
    // A resent event counts as accepted (the plugin stops retrying) and still takes budget.
    const room = this.#budget.take(agent, nowMs, maxEventsPerMinute, valid.length);
    const owned = new Map<string, boolean>();
    const mine = (session: string) => {
      if (!owned.has(session)) owned.set(session, this.ownsSession(agent, session));
      return owned.get(session);
    };
    this.ctx.db.transaction(() => {
      for (const event of valid.slice(0, room)) {
        // A session that is not the caller's own is not recorded, so nobody can pin events on another's.
        const stored = event.session && !mine(event.session) ? { ...event, session: null } : event;
        this.#repo.insert(agent, stored, receivedAt);
      }
    });
    return { accepted: room, dropped: events.length - room };
  }

  /** The newest events first (up to `limit`). */
  query(filter: Parameters<EventsRepo['query']>[0]): ObservedEvent[] {
    return this.#repo.query(filter);
  }

  /**
   * Operators only: the caller agent's owner must be in `observability.viewers`. The newest
   * `limit` matches, fewer when the reply would pass MAX_REPLY_BYTES (`truncated` says so).
   */
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
    const title = /^\d{1,4}[mhd]$/.test(p.since) ? `last ${p.since}` : `since ${since}`;
    const events = found.slice(0, p.limit).reverse();
    return fitTimeline(events, { title, truncated: found.length > p.limit });
  }

  prune(now: Date): number {
    const { retentionDays } = this.ctx.loaded.config.observability;
    return this.#repo.prune(new Date(now.getTime() - retentionDays * DAY_MS).toISOString());
  }
}

/** The callout's refusals name no agent, so they share one budget. */
const UNAUTHENTICATED = '(unauthenticated)';

/**
 * The hub's own events into the same store. Off when observability is off; never throws. An event
 * (or agent) that fails its schema is not stored, so no row can break a timeline read. A caller's
 * failed calls (`rpc`, per caller) and the callout's refusals (`auth`, one shared budget) are
 * capped at `maxEventsPerMinute` like reports, so a loop or an unauthenticated flood cannot grow
 * the table without bound; the hub's session, delivery, relay and orphan events are not. Events
 * queue and are written in one transaction of their own once the current task yields (a
 * microtask), so a flush's many events cost one commit and never share the outbox's transaction.
 * Best-effort: a crash before the write loses them.
 */
export function createEventSink(
  ctx: Pick<HubContext, 'db' | 'clock' | 'loaded' | 'logger'>,
): EventSink {
  const repo = new EventsRepo(ctx.db);
  const budget = new MinuteWindow();
  /** Budgets that have filled once: the first time warns, later drops log at debug. */
  const full = new Set<string>();
  let queue: Array<{ agent: string; event: HubEvent; at: string }> = [];
  const flush = () => {
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    try {
      ctx.db.transaction(() => {
        for (const { agent, event, at } of batch) repo.insert(agent, event, at);
      });
    } catch (err) {
      ctx.logger.debug({ err, count: batch.length }, 'could not record events');
    }
  };
  /** False, with a log line, when a capped kind is over its budget this minute. */
  const withinBudget = (agent: string, event: HubEvent, nowMs: number): boolean => {
    const key = event.kind === 'auth' ? UNAUTHENTICATED : event.kind === 'rpc' ? agent : null;
    const max = ctx.loaded.config.observability.maxEventsPerMinute;
    if (key === null || budget.take(key, nowMs, max, 1) > 0) return true;
    const level = full.has(key) ? 'debug' : 'warn';
    full.add(key);
    ctx.logger[level](
      { budget: key, kind: event.kind },
      'hub events over the per-minute cap; not recorded',
    );
    return false;
  };
  return {
    flush,
    record(agent, event: HubEvent) {
      try {
        if (!ctx.loaded.config.observability.enabled) return;
        if (!HubEvent.safeParse(event).success || !ParticipantId.safeParse(agent).success) {
          ctx.logger.debug({ kind: event?.kind }, 'hub event fails its schema; not recorded');
          return;
        }
        const now = ctx.clock.now();
        if (!withinBudget(agent, event, now.getTime())) return;
        if (queue.push({ agent, event, at: now.toISOString() }) === 1) queueMicrotask(flush);
      } catch (err) {
        ctx.logger.debug({ err, kind: event.kind }, 'could not record an event');
      }
    },
  };
}
