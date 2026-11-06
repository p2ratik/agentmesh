import type { Msg, NatsConnection } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import { subjects } from '@agentmesh/protocol';
import type { HubClient } from '../hub';

export interface SessionSubscription {
  stop(): void;
  resubscribe(): void;
  retryFailed(): void;
}

/**
 * Listens on `{p}.session.{agent}.{session}` and hands each message to `handle`, one at a time,
 * so pushes keep the hub's order. `resubscribe` follows `hub.sessionId`; `retryFailed`
 * resubscribes after the server refused or ended the subscription (a permissions violation).
 * The subscription ends for good on `stop` or when `signal` aborts.
 */
export function followSessionSubject(
  options: { hub: HubClient; logger: Logger; signal: AbortSignal; onListening(): void },
  handle: (msg: Msg) => Promise<void>,
): SessionSubscription {
  const { hub, logger } = options;
  let sub: ReturnType<NatsConnection['subscribe']> | null = null;
  let stopped = false;
  let failed = false;
  let queue = Promise.resolve();

  const resubscribe = (): void => {
    sub?.unsubscribe();
    sub = null;
    failed = false;
    const { connection: nc, sessionId } = hub;
    if (stopped || !nc || !sessionId) return;
    const subject = subjects(hub.config.prefix).session(hub.config.agentId, sessionId);
    try {
      sub = nc.subscribe(subject, {
        callback: (err, msg) => {
          if (err) {
            // NATS closes the subscription after this (a permissions violation, say).
            failed = true;
            logger.error(
              { err, subject },
              'session subscription failed; retrying on the next beat',
            );
            return;
          }
          queue = queue
            .then(() => handle(msg))
            .catch((error) => logger.error({ err: error }, 'session delivery failed'));
        },
      });
      logger.debug({ subject }, 'listening for deliveries');
      // NATS keeps one connection's SUB and PUB in order: the server has the subscription first.
      options.onListening();
    } catch (err) {
      // A closed or draining connection refuses new subscriptions.
      failed = true;
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
  const retryFailed = (): void => {
    if (failed) resubscribe();
  };
  return { stop, resubscribe, retryFailed };
}
