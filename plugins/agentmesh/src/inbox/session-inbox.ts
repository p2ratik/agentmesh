import type { Msg, NatsConnection } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import { type SessionAck, SessionInbound, subjects } from '@agentmesh/protocol';
import type { HubClient } from '../hub';
import { RecentIds } from './recent-ids';
import { type ChannelEvent, renderEvent } from './render';

export interface SessionInboxOptions {
  hub: HubClient;
  logger: Logger;
  signal: AbortSignal;
  /** Writes one channel notification to Claude Code. */
  push(event: ChannelEvent): Promise<void>;
  /** The hub no longer knows this session; say hello again. */
  onExpired(): void;
}

/**
 * Takes the hub's deliveries on `{p}.session.{agent}.{session}` and pushes
 * them into Claude Code: one event per thread, threads in arrival order. The
 * reply (`SessionAck`) lists the ids whose push succeeded, plus redeliveries
 * already pushed; the hub retries the rest. Batches are handled one at a time,
 * so pushes keep the hub's order. `resubscribe` follows `hub.sessionId`.
 */
export function runSessionInbox(options: SessionInboxOptions): {
  stop(): void;
  resubscribe(): void;
} {
  const { hub, logger } = options;
  const seen = new RecentIds();
  let sub: ReturnType<NatsConnection['subscribe']> | null = null;
  let stopped = false;
  let queue = Promise.resolve();

  const handle = async (msg: Msg): Promise<void> => {
    let inbound: SessionInbound;
    try {
      inbound = SessionInbound.parse(msg.json());
    } catch {
      logger.warn({ subject: msg.subject }, 'ignoring a malformed session message');
      return;
    }
    if (inbound.type === 'expired') return options.onExpired();
    const delivered: string[] = [];
    for (const thread of Map.groupBy(inbound.messages, (m) => m.threadId).values()) {
      const fresh = thread.filter((m) => !seen.has(m.id));
      delivered.push(...thread.filter((m) => seen.has(m.id)).map((m) => m.id));
      if (fresh.length === 0) continue;
      try {
        await options.push(renderEvent(fresh));
      } catch (err) {
        logger.warn(
          { err, thread: fresh[0]?.threadId },
          'could not push a mesh thread; the hub retries',
        );
        continue;
      }
      for (const m of fresh) seen.remember(m.id);
      delivered.push(...fresh.map((m) => m.id));
    }
    const ack: SessionAck = { delivered };
    msg.respond(JSON.stringify(ack));
  };

  const resubscribe = (): void => {
    sub?.unsubscribe();
    sub = null;
    const { connection: nc, sessionId } = hub;
    if (stopped || !nc || !sessionId) return;
    const subject = subjects(hub.config.prefix).session(hub.config.agentId, sessionId);
    try {
      sub = nc.subscribe(subject, {
        callback: (err, msg) => {
          if (err) {
            logger.warn({ err, subject }, 'session subscription error');
            return;
          }
          queue = queue
            .then(() => handle(msg))
            .catch((error) => logger.error({ err: error }, 'session delivery failed'));
        },
      });
      logger.debug({ subject }, 'listening for deliveries');
    } catch (err) {
      // A closed or draining connection refuses new subscriptions.
      logger.error({ err, subject }, 'could not listen for deliveries');
    }
  };

  const stop = (): void => {
    stopped = true;
    sub?.unsubscribe();
    sub = null;
  };
  options.signal.addEventListener('abort', stop, { once: true });
  resubscribe();
  return { stop, resubscribe };
}
