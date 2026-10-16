import { type JetStreamClient, publishJson, runConsumer } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import {
  consumerNames,
  IngestEvent,
  parseTokenAfter,
  streamNames,
  subjects,
} from '@agentmesh/protocol';
import { eventId, type IdentifiedEvent } from './http/normalize';

/** How events reach the rules engine durably. NATS in production. */
export interface IngestTransport {
  publish(source: string, event: IdentifiedEvent): Promise<void>;
  /** Consumes until `signal` aborts. */
  run(
    handler: (source: string, event: IngestEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * Producers with NATS credentials (e.g. a Hermes bot) publish IngestEvent JSON
 * to `{prefix}.ingest.{source}`; NATS permissions make the subject the proof
 * of who sent it. The HTTP endpoint publishes the same shape.
 */
export function createNatsIngestTransport(
  js: JetStreamClient,
  prefix: string,
  logger: Logger,
): IngestTransport {
  const subs = subjects(prefix);
  return {
    publish: async (source, event) => {
      await publishJson(js, subs.ingest(source), event, event.id);
    },
    run: (handler, signal) =>
      runConsumer(
        js,
        async (msg) => {
          const source = parseTokenAfter(prefix, 'ingest', msg.subject);
          if (!source) return 'drop';
          let body: unknown;
          try {
            body = msg.json();
          } catch {
            return 'drop';
          }
          const parsed = IngestEvent.safeParse(body);
          if (!parsed.success) {
            logger.warn(
              { source, issues: parsed.error.issues.length },
              'dropping invalid ingest event',
            );
            return 'drop';
          }
          await handler(source, {
            ...parsed.data,
            id: eventId(source, parsed.data.id, msg.string()),
          });
          return 'ack';
        },
        { stream: streamNames(prefix).ingest, consumer: consumerNames.ingest, logger, signal },
      ),
  };
}
