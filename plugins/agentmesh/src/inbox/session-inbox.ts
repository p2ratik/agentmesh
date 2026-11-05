import type { Msg } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import {
  type RelayAnswer,
  type SessionAck,
  type SessionDelivery,
  SessionInbound,
  type SessionRelay,
} from '@agentmesh/protocol';
import type { HubClient } from '../hub';
import { threadNotice } from './closed-asker';
import { anyExternal, type FyiBuffer, formatFyi, seenIds, type TakenFyi } from './fyi';
import { RecentIds } from './recent-ids';
import { type ChannelEvent, decides, renderEvent } from './render';
import { followSessionSubject, type SessionSubscription } from './session-subscription';

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
  /** The mesh window's answer to a relay: a pointer for one of its human's private sessions. */
  onRelay(relay: SessionRelay): Promise<RelayAnswer>;
  /** How long the hub waits on a closed asker's answer before it pings the owner (from hello). */
  closedAskerMinutes(): number;
}

/**
 * Takes the hub's deliveries on `{p}.session.{agent}.{session}` (see
 * `followSessionSubject`). Status items go into the FYI buffer, never into a
 * push of their own (a push starts a turn); each id once per process, though
 * the hub carries a thread's unread status along with later deliveries. Action
 * items are pushed into Claude Code, one event per thread in arrival order; the
 * first push that works takes the FYI buffer as its footer, and those ids are
 * reported seen. A thread with a closed asker's answer carries its notice. The
 * reply (`SessionAck`) lists the ids buffered or pushed now or before; the hub
 * retries the rest. An activation check is pushed, then acked; a relay is
 * acked with `onRelay`'s answer.
 */
export function runSessionInbox(options: SessionInboxOptions): SessionSubscription {
  const { hub, logger } = options;
  const seen = new RecentIds();

  const handle = async (msg: Msg): Promise<void> => {
    let inbound: SessionInbound;
    try {
      inbound = SessionInbound.parse(msg.json());
    } catch {
      logger.warn({ subject: msg.subject }, 'ignoring a malformed session message');
      return;
    }
    if (inbound.type === 'expired') return options.onExpired();
    if (inbound.type === 'relay') {
      // A pointer, not a message: it never touches the FYI buffer or RecentIds.
      const ack: SessionAck = { delivered: [], ...(await options.onRelay(inbound)) };
      msg.respond(JSON.stringify(ack));
      return;
    }
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
      // The buffer rides along with the first push that works, never under an owner's command
      // (decides=yes): nothing of anyone else's goes under that mark. A failed push puts it back,
      // since RecentIds would not let a redelivery buffer those items again.
      const owner = fresh.every((m) => decides(m, hub.config.agentId));
      const fyi = owner ? { items: [], dropped: [] } : options.fyi.take();
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
      const notice = threadNotice(fresh, options.closedAskerMinutes());
      const footer = { footer: formatFyi(fyi), footerExternal: anyExternal(fyi), notice };
      await options.push(renderEvent(fresh, { selfId: hub.config.agentId, ...footer }));
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

  return followSessionSubject(options, handle);
}
