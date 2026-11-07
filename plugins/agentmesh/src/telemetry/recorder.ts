import { randomUUID } from 'node:crypto';
import { VERSION } from '@agentmesh/common';
import { type ReportedEvent, Version } from '@agentmesh/protocol';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Session } from '../session';

type WithoutStamp<E> = E extends unknown
  ? Omit<E, 'id' | 'at'> & { id?: string; at?: string }
  : never;
/** An event as recorded: the recorder stamps `id` and `at` unless it has them (a file's do). */
export type Recordable = WithoutStamp<ReportedEvent>;
type Dropped = Extract<ReportedEvent, { kind: 'dropped' }>;

/** Error-kind events, after which the shipper sends early. */
function isError(e: Recordable): boolean {
  switch (e.kind) {
    case 'nats':
      return e.event === 'error';
    case 'activation':
      return e.phase === 'failed' || e.phase === 'refused';
    case 'delivery':
      return e.stage === 'push_failed';
    case 'guard':
      return e.decision === 'deny';
    default:
      return false;
  }
}

/**
 * The plugin's capped buffer of timeline events (ids, counts and codes only). Over the cap the
 * oldest go, and one pending `dropped` event counts them, so a gap is visible, never silent.
 */
export class Recorder {
  /** Set by the shipper: called after an error-kind event. */
  onError: (() => void) | null = null;
  readonly #max: () => number;
  readonly #now: () => Date;
  #events: ReportedEvent[] = [];
  #gap: Dropped | null = null;
  #off = false;
  /**
   * The one on/off state. It starts off: nothing has said observability is on yet. Each hello
   * sets it (`on()` or `pause()`), a report refused as off pauses it, and a report the hub takes
   * (an empty check, while paused) turns it on.
   */
  #paused: boolean;

  constructor(opts: { max: () => number; on?: boolean; now?: () => Date }) {
    this.#max = opts.max;
    this.#paused = !opts.on;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Off for this process (a hub without `telemetry.report`): drops what it holds, for good. */
  off(): void {
    this.#off = true;
    this.pause();
  }

  /** Observability is off: drops what it holds and records nothing until `on()`. */
  pause(): void {
    this.#paused = true;
    this.#events = [];
    this.#gap = null;
  }

  /** Observability is on: records again, unless `off()` stopped it for good. */
  on(): void {
    this.#paused = false;
  }

  /** Off but not for good: the shipper checks back each beat. */
  get paused(): boolean {
    return this.#paused && !this.#off;
  }

  #on(): boolean {
    return !this.#off && !this.#paused;
  }

  /** Synchronous and never throws; records nothing while the hub says observability is off. */
  record(e: Recordable): void {
    try {
      if (!this.#on()) return;
      const stamp = { id: e.id ?? randomUUID(), at: e.at ?? this.#now().toISOString() };
      this.#events.push({ ...e, ...stamp } as ReportedEvent);
      this.#trim();
      if (isError(e)) this.onError?.();
    } catch {
      // Recording never gets in the way of the work it records.
    }
  }

  /** Removes up to `n` events, the pending gap first. Turned off, it drops what it holds. */
  take(n: number): ReportedEvent[] {
    if (!this.#on()) {
      this.#events = [];
      this.#gap = null;
      return [];
    }
    const taken: ReportedEvent[] = this.#gap ? [this.#gap] : [];
    this.#gap = null;
    return taken.concat(this.#events.splice(0, n - taken.length));
  }

  /** Returns events the hub did not take to the front; what no longer fits counts as dropped. */
  putBack(events: ReportedEvent[]): void {
    for (const e of events) {
      if (e.kind === 'dropped') this.#gap = { ...e, count: e.count + (this.#gap?.count ?? 0) };
    }
    this.#events.unshift(...events.filter((e) => e.kind !== 'dropped'));
    this.#trim();
  }

  /** Counts events lost before they reached the buffer (one that failed validation) in the gap. */
  countDropped(count: number): void {
    if (count > 0 && this.#on()) this.#addGap(count, null);
  }

  #trim(): void {
    const over = this.#events.length - this.#max();
    if (over > 0) this.#addGap(over, this.#events.splice(0, over).at(-1)?.session ?? null);
  }

  #addGap(count: number, session: string | null): void {
    this.#gap = this.#gap
      ? { ...this.#gap, count: this.#gap.count + count }
      : {
          kind: 'dropped',
          source: 'plugin',
          session,
          id: randomUUID(),
          at: this.#now().toISOString(),
          count,
        };
  }
}

/** What each hello that lands records: versions and the session's mode, nothing else. */
export function connectedEvent(
  session: Pick<Session, 'hub' | 'window' | 'activation'>,
  server: Pick<Server, 'getClientVersion'>,
): Recordable {
  // Null (the timeline says unknown) when the host didn't say, or said something that isn't a
  // version, so a dev build's `dev` never costs the whole event.
  const version = server.getClientVersion()?.version;
  return {
    kind: 'connected',
    source: 'plugin',
    session: session.hub.sessionId,
    pluginVersion: VERSION,
    claudeCodeVersion: version && Version.safeParse(version).success ? version : null,
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    meshWindow: session.window.state === 'verified',
    pull: session.activation.pull,
  };
}
