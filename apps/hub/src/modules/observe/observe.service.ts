import { MeshError } from '@agentmesh/common';
import type { HubEvent, ObservedEvent, ReportedEvent } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { EventSink } from '../../contracts';
import { type EventFilter, EventsRepo } from './events.repo';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class ObserveService {
  readonly #repo: EventsRepo;
  /** Receive times (ms) of each agent's stored events in the last minute. In memory. */
  readonly #recent = new Map<string, number[]>();

  constructor(private readonly ctx: Pick<HubContext, 'db' | 'clock' | 'loaded'>) {
    this.#repo = new EventsRepo(ctx.db);
  }

  /** Stores what `agent` (proven by NATS) reported. Any `agent` inside an event is ignored. */
  report(agent: string, events: ReportedEvent[]): { accepted: number; dropped: number } {
    const { enabled, maxEventsPerMinute } = this.ctx.loaded.config.observability;
    if (!enabled) throw new MeshError('forbidden', 'observability is turned off on this hub');
    const nowMs = this.ctx.clock.now().getTime();
    const receivedAt = new Date(nowMs).toISOString();
    const recent = (this.#recent.get(agent) ?? []).filter((t) => nowMs - t < MINUTE_MS);
    let accepted = 0;
    let dropped = 0;
    for (const event of events) {
      if (recent.length >= maxEventsPerMinute) {
        dropped += 1;
        continue;
      }
      // A resent event counts as accepted (the plugin stops retrying) but takes no budget.
      if (this.#repo.insert(agent, event, receivedAt)) recent.push(nowMs);
      accepted += 1;
    }
    this.#recent.set(agent, recent);
    return { accepted, dropped };
  }

  query(filter: EventFilter): ObservedEvent[] {
    return this.#repo.query(filter);
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
