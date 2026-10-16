import { type Disposition, type JetStreamClient, type JsMsg, runConsumer } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import type { ConfigIndex } from '@agentmesh/config';
import { consumerNames, DomainEvent, streamNames } from '@agentmesh/protocol';
import type { EchoGuard } from '../echo';
import { type Executor, isPermanentDiscordError } from './executor';
import { routeEvent } from './route';

export interface FeedOptions {
  js: JetStreamClient;
  prefix: string;
  serviceId: string;
  index: ConfigIndex;
  executor: Executor;
  echo: EchoGuard;
  logger: Logger;
  signal: AbortSignal;
}

/**
 * Mirrors the activity feed into Discord, one event at a time (order matters).
 * The durable consumer resumes where it left off after the bridge restarts.
 */
export function runFeed(options: FeedOptions): Promise<void> {
  return runConsumer(options.js, (msg) => handleFeedMessage(msg, options), {
    stream: streamNames(options.prefix).events,
    consumer: consumerNames.feed(options.serviceId),
    logger: options.logger,
    signal: options.signal,
    concurrency: 1,
  });
}

/** Parses, skips echoes of our own relays, then performs every post the event maps to. */
export async function handleFeedMessage(
  msg: Pick<JsMsg, 'json' | 'subject'>,
  options: FeedOptions,
): Promise<Disposition> {
  let raw: unknown;
  try {
    raw = msg.json();
  } catch {
    return 'drop';
  }
  const parsed = DomainEvent.safeParse(raw);
  if (!parsed.success) {
    options.logger.warn({ subject: msg.subject }, 'dropping unknown feed event');
    return 'drop';
  }
  const event = parsed.data;
  if (event.type === 'message.created' && (await options.echo.isEcho(event.data.message.id))) {
    return 'ack';
  }
  for (const intent of routeEvent(event, options.index)) {
    await performSkippingPermanentFailures(options, intent, event.type);
  }
  return 'ack';
}

/** Posts Discord will never accept are logged and skipped; anything else throws (and is retried). */
async function performSkippingPermanentFailures(
  options: FeedOptions,
  intent: Parameters<Executor['perform']>[0],
  eventType: string,
): Promise<void> {
  try {
    await options.executor.perform(intent);
  } catch (err) {
    if (!isPermanentDiscordError(err)) throw err;
    options.logger.error(
      { err, event: eventType, purpose: intent.purpose },
      'discord rejected a post; skipping',
    );
  }
}
