import { backoffDelay, type Logger, sleep } from '@agentmesh/common';
import type { JetStreamClient, JsMsg } from '@nats-io/jetstream';

/** What to do with a message after handling it. */
export type Disposition = 'ack' | 'retry' | 'drop';

export interface ConsumeOptions {
  stream: string;
  consumer: string;
  logger: Logger;
  signal: AbortSignal;
  /** Messages pulled per request. */
  batch?: number;
  /** Delay before a `retry` is redelivered. */
  retryDelayMs?: number;
  /**
   * Handlers allowed in flight at once (default 1 = strict order). Raise it
   * when the handler batches work, e.g. coalescing messages before acking.
   */
  concurrency?: number;
}

export type MessageHandler = (msg: JsMsg) => Promise<Disposition>;

/**
 * Runs a durable pull consumer until `signal` aborts. Survives a missing
 * consumer (the hub may create it later), lost heartbeats and reconnects.
 * Handler exceptions are treated as `retry`.
 */
export async function runConsumer(
  js: JetStreamClient,
  handler: MessageHandler,
  options: ConsumeOptions,
): Promise<void> {
  const { logger, signal } = options;
  const limit = Math.max(1, options.concurrency ?? 1);
  let failures = 0;
  while (!signal.aborted) {
    try {
      const consumer = await js.consumers.get(options.stream, options.consumer);
      const messages = await consumer.consume({ max_messages: options.batch ?? 20 });
      const stop = () => messages.stop();
      signal.addEventListener('abort', stop, { once: true });
      void watchHeartbeats(messages, logger);
      failures = 0;
      const inFlight = new Set<Promise<void>>();
      for await (const msg of messages) {
        const task = dispatch(msg, handler, options).finally(() => inFlight.delete(task));
        inFlight.add(task);
        if (inFlight.size >= limit) await Promise.race(inFlight);
      }
      await Promise.all(inFlight);
      signal.removeEventListener('abort', stop);
    } catch (error) {
      if (signal.aborted) break;
      failures += 1;
      const delay = backoffDelay(failures, { initialDelayMs: 1_000, maxDelayMs: 30_000 });
      logger.warn(
        { err: error, consumer: options.consumer, retryInMs: delay },
        'consumer unavailable',
      );
      await sleep(delay, signal).catch(() => undefined);
    }
  }
}

async function dispatch(
  msg: JsMsg,
  handler: MessageHandler,
  options: ConsumeOptions,
): Promise<void> {
  let disposition: Disposition;
  try {
    disposition = await handler(msg);
  } catch (error) {
    options.logger.error(
      { err: error, subject: msg.subject, seq: msg.seq },
      'message handler failed',
    );
    disposition = 'retry';
  }
  if (disposition === 'ack') msg.ack();
  else if (disposition === 'retry') msg.nak(options.retryDelayMs ?? 5_000);
  else msg.term('dropped by handler');
}

async function watchHeartbeats(
  messages: { status(): AsyncIterable<{ type: string }>; stop(): void },
  logger: Logger,
): Promise<void> {
  try {
    let missed = 0;
    for await (const status of messages.status()) {
      if (status.type === 'heartbeats_missed') {
        missed += 1;
        if (missed >= 2) {
          logger.warn('consumer heartbeats missed; restarting consume');
          messages.stop();
          return;
        }
      } else if (status.type === 'next' || status.type === 'heartbeat') {
        missed = 0;
      }
    }
  } catch {
    // the status iterator ends when consume stops
  }
}
