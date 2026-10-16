import { jetstream, runConsumer } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import { consumerNames, MeshMessage, streamNames } from '@agentmesh/protocol';
import type { HubClient } from '../hub';
import { Coalescer, RecentIds } from './coalescer';
import { type ChannelEvent, renderEvent } from './render';

const COALESCE_MS = 1200;

export interface InboxOptions {
  hub: HubClient;
  logger: Logger;
  signal: AbortSignal;
  /** Writes one channel notification to Claude Code. */
  push(event: ChannelEvent): Promise<void>;
}

/**
 * Drains this agent's durable inbox into the Claude Code session. Messages
 * are acked only after their notification was written; malformed ones are
 * dropped; redeliveries of something already pushed are acked silently.
 */
export async function runInbox(options: InboxOptions): Promise<Coalescer> {
  const { hub, logger, signal } = options;
  const coalescer = new Coalescer(COALESCE_MS, (messages) => options.push(renderEvent(messages)));
  const seen = new RecentIds();
  const nc = await hub.whenConnected();
  const { agentId, prefix } = hub.config;
  void runConsumer(
    jetstream(nc),
    async (msg) => {
      let body: unknown;
      try {
        body = msg.json();
      } catch {
        return 'drop';
      }
      const parsed = MeshMessage.safeParse(body);
      if (!parsed.success) {
        logger.warn({ subject: msg.subject }, 'dropping malformed mesh message');
        return 'drop';
      }
      if (seen.has(parsed.data.id)) return 'ack';
      try {
        await coalescer.add(parsed.data);
        // Only now: a failed push must be retried, not mistaken for a duplicate later.
        seen.remember(parsed.data.id);
        return 'ack';
      } catch (err) {
        logger.warn({ err, message: parsed.data.id }, 'could not push a mesh message; will retry');
        return 'retry';
      }
    },
    {
      stream: streamNames(prefix).delivery,
      consumer: consumerNames.inbox(agentId),
      logger,
      signal,
      batch: 50,
      concurrency: 50,
    },
  );
  return coalescer;
}
