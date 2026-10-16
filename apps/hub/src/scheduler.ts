import type { Clock, Logger } from '@agentmesh/common';
import type { TickJob } from './contracts';

/**
 * One interval drives every periodic job (outbox retries, presence expiry,
 * plan deadlines, lease expiry). Jobs run in order; a failing job is logged
 * and never stops the others; ticks never overlap.
 */
export class Scheduler {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #jobs: TickJob[] = [];
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;

  constructor(clock: Clock, logger: Logger, intervalMs: number) {
    this.#clock = clock;
    this.#logger = logger;
    this.#intervalMs = intervalMs;
  }

  add(job: TickJob): void {
    this.#jobs.push(job);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  /** Runs every job once. Concurrent calls share the tick in progress. */
  tick(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = (async () => {
      try {
        for (const job of this.#jobs) {
          try {
            await job.run(this.#clock.now());
          } catch (err) {
            this.#logger.error({ err, job: job.name }, 'scheduled job failed');
          }
        }
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }
}
