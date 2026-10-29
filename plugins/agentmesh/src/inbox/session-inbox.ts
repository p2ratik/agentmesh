import type { Msg, NatsConnection } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import {
  type SessionAck,
  type SessionDelivery,
  SessionInbound,
  subjects,
} from '@agentmesh/protocol';
import type { HubClient } from '../hub';
import { anyExternal, type FyiBuffer, formatFyi, seenIds, type TakenFyi } from './fyi';
import { RecentIds } from './recent-ids';
import { type ChannelEvent, renderEvent } from './render';

export interface SessionInboxOptions {
  hub: HubClient;
  logger: Logger;
  signal: AbortSignal;
  /** Status items wait here to ride along; tool results take them too. */
  fyi: FyiBuffer;
  /** Writes one channel notification to Claude Code. */
  push(event: ChannelEvent): Promise<void>;
  /** Pushes the activation check that carries `code`. */
  pushCheck(code: string): Promise<void>;
  /** The hub no longer knows this session; say hello again. */
  onExpired(): void;
  /**
   * Now listening on the session subject. The hub marks a session away when a
   * delivery finds nobody listening (startup, re-hello) until it hears a heartbeat.
   */
  onListening(): void;
}

/**
 * Takes the hub's deliveries on `{p}.session.{agent}.{session}`. Status items
 * go into the FYI buffer, never into a push of their own (a push starts a
 * turn); each id once per process, though the hub carries a thread's unread
 * status along with later deliveries. Action items are pushed into Claude
 * Code, one event per thread in arrival order; the first push that works takes
 * the FYI buffer as its footer, and those ids are reported seen. The reply
 * (`SessionAck`) lists the ids buffered or pushed now or before; the hub
 * retries the rest. An activation check is pushed, then acked. Batches are
 * handled one at a time, so pushes keep the hub's order. `resubscribe` follows
 * `hub.sessionId`; `retryFailed` resubscribes after the server refused or
 * ended the subscription (a permissions violation).
 */
export function runSessionInbox(options: SessionInboxOptions): {
  stop(): void;
  resubscribe(): void;
  retryFailed(): void;
} {
  const { hub, logger } = options;
  const seen = new RecentIds();
  let sub: ReturnType<NatsConnection['subscribe']> | null = null;
  let stopped = false;
  let failed = false;
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
    if (inbound.type === 'check') await options.pushCheck(inbound.code);
    const delivered: string[] = [];
    const shown = inbound.type === 'deliver' ? await deliver(inbound.messages, delivered) : [];
    const ack: SessionAck = { delivered };
    msg.respond(JSON.stringify(ack));
    hub.reportSeen(shown);
  };

  /** Buffers the status items, then pushes the action threads; returns the FYI ids shown. */
  const deliver = async (messages: SessionDelivery[], delivered: string[]): Promise<string[]> => {
    const status = messages.filter((m) => m.class === 'status');
    options.fyi.add(status.filter((m) => seen.remember(m.id)));
    delivered.push(...status.map((m) => m.id));
    const shown: string[] = [];
    const actions = messages.filter((m) => m.class !== 'status');
    for (const thread of Map.groupBy(actions, (m) => m.threadId).values()) {
      const fresh = thread.filter((m) => !seen.has(m.id));
      delivered.push(...thread.filter((m) => seen.has(m.id)).map((m) => m.id));
      if (fresh.length === 0) continue;
      // The buffer rides along with the first push that works. A failed push puts it back,
      // since RecentIds would not let a redelivery buffer those items again.
      const fyi = options.fyi.take();
      if (await pushThread(fresh, fyi, delivered)) shown.push(...seenIds(fyi));
      else options.fyi.putBack(fyi);
    }
    return shown;
  };

  /** Pushes one thread's new action items; true (and acked) when Claude Code took them. */
  const pushThread = async (
    fresh: SessionDelivery[],
    fyi: TakenFyi,
    delivered: string[],
  ): Promise<boolean> => {
    try {
      await options.push(
        renderEvent(fresh, { footer: formatFyi(fyi), footerExternal: anyExternal(fyi) }),
      );
    } catch (err) {
      logger.warn(
        { err, thread: fresh[0]?.threadId },
        'could not push a mesh thread; the hub retries',
      );
      return false;
    }
    for (const m of fresh) seen.remember(m.id);
    delivered.push(...fresh.map((m) => m.id));
    return true;
  };

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
