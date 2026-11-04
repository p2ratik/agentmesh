import type { Logger } from '@agentmesh/common';
import type { RelayAnswer, SessionDelivery, SessionRelay } from '@agentmesh/protocol';
import type { MessagingService, SessionsService } from '../../contracts';
import type { DeliveryPort, DeliveryReceipt } from '../../ports';
import { RelayMarks, type RelayTarget } from './relay';
import { follow, withReleased } from './released';
import type { Route } from './routing';

export interface SessionTransport {
  /** Hands messages to one session; resolves with the ids it pushed into Claude Code. */
  send(agentId: string, sessionId: string, messages: SessionDelivery[]): Promise<string[]>;
  /** Tells a plugin its session is gone so it says hello again. */
  expired(agentId: string, sessionId: string): void;
  /** Hands one session its activation code; resolves once it acked, throws if nobody answered. */
  check(agentId: string, sessionId: string, code: string): Promise<void>;
  /** Hands the mesh window a pointer to a private session's reply; resolves with its answer. */
  relay(agentId: string, sessionId: string, relay: SessionRelay): Promise<RelayAnswer>;
}

/** The most unread status items of one thread that ride along with a delivery in it. */
const CARRIED_PER_THREAD = 20;

interface Routed {
  message: SessionDelivery;
  route: Extract<Route, { kind: 'deliver' }>;
}

interface Relay {
  message: SessionDelivery;
  target: RelayTarget;
}

/**
 * The outbox's delivery port (spec §3). Routes each message to one session of
 * its agent, hands every session its batch at once, and returns the acked ids
 * with a `commit` that claims ownership and advances the read cursor. The
 * outbox runs that commit in the transaction that marks the rows published, so
 * "delivered", "read" and "owned" are one step. Messages the agent already read
 * (through `inbox` or `thread`) count as delivered without a push.
 *
 * Status items (spec §4) route like action ones but never claim. They stay
 * unread until shown and reported through `messages.seen`, until `inbox` or
 * `thread` returns them, or until a later delivery in their thread that carried
 * them along passes them. A status shown only to a session that died before
 * reporting it seen may be shown twice: there, and again with the next delivery
 * in its thread. That is acceptable for FYI.
 *
 * A reply that waits for an inactive private session may wake it through the
 * mesh window (spec §4.1): the window gets a body-less `relay` pointer, once
 * per thread and asking session until the owner reads the thread. The reply
 * itself stays pending: never delivered, read or claimed here.
 *
 * A thread whose private asker closed goes to a 0.6.0 window unclaimed, its messages marked
 * `released`; the commit starts the owner's decision timer (`OrphanDecisions`).
 */
export class SessionDispatcher implements DeliveryPort {
  readonly #sessions: SessionsService;
  readonly #messaging: MessagingService;
  readonly #transport: SessionTransport;
  readonly #logger: Logger;
  readonly #marks = new RelayMarks();

  constructor(deps: {
    sessions: SessionsService;
    messaging: MessagingService;
    transport: SessionTransport;
    logger: Logger;
  }) {
    this.#sessions = deps.sessions;
    this.#messaging = deps.messaging;
    this.#transport = deps.transport;
    this.#logger = deps.logger;
  }

  async deliver(agentId: string, messages: SessionDelivery[]): Promise<DeliveryReceipt> {
    // Already read through inbox or thread: delivered, with nothing to push, claim or mark read.
    const alreadyRead = messages.filter((m) => this.#messaging.isRead(agentId, m.id));
    // The owner read the thread: its next reply may wake it again.
    for (const m of alreadyRead) this.#marks.clearThread(agentId, m.threadId);
    const seen = alreadyRead.map((m) => m.id);
    // No active, live session: every route would wait.
    if (!this.#sessions.hasReadySession(agentId)) return { delivered: seen };
    const unseen = messages.filter((m) => !seen.includes(m.id));
    const { routed, waiting } = this.#route(agentId, unseen);
    // Fire and forget: a window that never answers must not hold up this flush.
    for (const r of this.#relays(agentId, waiting)) void this.#relay(agentId, r);
    const batches = [...Map.groupBy(routed, (r) => r.route.sessionId)];
    // Every send starts before any is awaited, so a dead session never holds up the others.
    const results = await Promise.allSettled(
      batches.map(([sessionId, batch]) => this.#send(agentId, sessionId, batch)),
    );
    const acked = new Set<string>();
    batches.forEach(([sessionId], i) => {
      const result = results[i];
      if (result?.status === 'fulfilled') {
        for (const id of result.value) acked.add(id);
        return;
      }
      this.#sessions.unreachable(sessionId);
      this.#logger.warn(
        { agent: agentId, session: sessionId, err: result?.reason },
        'session unreachable; its deliveries wait',
      );
    });
    // In message order, so the first claim on a thread wins.
    const delivered = routed.filter((r) => acked.has(r.message.id));
    // Status rides along: published, but it claims nothing and stays unread until seen.
    const actions = delivered.filter((r) => r.message.class === 'action');
    const read = actions.map((r) => r.message.id);
    return {
      delivered: [...seen, ...delivered.map((r) => r.message.id)],
      commit: () => {
        for (const { message, route } of actions) {
          this.#sessions.delivered(agentId, route.sessionId, message, route);
        }
        // markRead trusts its caller: only this agent, only action items its sessions acked.
        this.#messaging.markRead(agentId, read);
      },
    };
  }

  /**
   * Per thread, the first waiting message that wakes its inactive private owner through the
   * mesh window, unless that owner was pointed to the thread since it last read it.
   */
  #relays(agentId: string, waiting: SessionDelivery[]): Relay[] {
    const relays = new Map<string, Relay>();
    for (const message of waiting) {
      if (relays.has(message.threadId)) continue;
      const target = this.#sessions.relay(agentId, message);
      if (target) relays.set(message.threadId, { message, target });
    }
    return [...relays.values()].filter(
      ({ message, target }) => !this.#marks.has(agentId, message.threadId, target.forSession),
    );
  }

  /**
   * Never rejects. Marked before the request, so no flush sends it again while it is in flight;
   * any answer keeps the mark (`forwarded: false` included). A failed request unmarks it so the
   * next flush tries again; the window is never marked away for it.
   */
  async #relay(agentId: string, { message, target }: Relay): Promise<void> {
    const { id, threadId } = message;
    const { windowId, forSession } = target;
    const log = { agent: agentId, window: windowId, thread: threadId, message: id };
    this.#marks.set(agentId, threadId, forSession);
    try {
      const answer = await this.#transport.relay(agentId, windowId, {
        type: 'relay',
        threadId,
        messageId: id,
        from: message.from.id,
        forSession,
      });
      this.#logger.info({ ...log, ...answer }, 'relay pointer sent');
    } catch (err) {
      this.#marks.delete(agentId, threadId, forSession);
      this.#logger.warn({ ...log, err }, 'relay pointer failed; the next flush sends it again');
    }
  }

  /** The ids the session acked, among those it was sent (carried status items aside). */
  async #send(agentId: string, sessionId: string, batch: Routed[]): Promise<string[]> {
    const messages = batch.map((r) => r.message);
    const routed = batch.map((r) => withReleased(r.message, r.route));
    const sent = [...this.#carried(agentId, messages), ...routed];
    const acked = new Set(await this.#transport.send(agentId, sessionId, sent));
    return messages.filter((m) => acked.has(m.id)).map((m) => m.id);
  }

  /**
   * Each thread's unread status items that are not in the batch and are older than
   * the thread's newest message in it, oldest first, to ride along with it. So
   * nothing held or past the outbox's window is shown early. Their rows are
   * already published, so they are never returned as delivered, claim nothing and
   * are never marked read here; the plugin dedups any it already holds.
   */
  #carried(agentId: string, messages: SessionDelivery[]): SessionDelivery[] {
    const inBatch = new Set(messages.map((m) => m.id));
    // The batch keeps the outbox's order, so the last message of a thread is its newest.
    const newest = new Map(messages.map((m) => [m.threadId, m.id]));
    return [...newest.values()].flatMap((id) =>
      this.#messaging
        .unreadStatusBefore(agentId, id, CARRIED_PER_THREAD)
        .filter((m) => !inBatch.has(m.id)),
    );
  }

  /**
   * In order. A thread's later messages follow its first one in this call: they
   * wait with it, or go to its session (claims commit only after the sends, so
   * routing them afresh could split a new thread across sessions). Also returns
   * the messages that wait, for the relay.
   */
  #route(
    agentId: string,
    messages: SessionDelivery[],
  ): { routed: Routed[]; waiting: SessionDelivery[] } {
    const firstOfThread = new Map<string, Route>();
    const routed: Routed[] = [];
    const waiting: SessionDelivery[] = [];
    for (const message of messages) {
      const first = firstOfThread.get(message.threadId);
      const route = first ? follow(first) : this.#sessions.route(agentId, message);
      if (!first) firstOfThread.set(message.threadId, route);
      const session = route.kind === 'deliver' ? route.sessionId : null;
      this.#logger.debug(
        { agent: agentId, message: message.id, session, reason: route.reason },
        'delivery routed',
      );
      if (route.kind === 'deliver') routed.push({ message, route });
      else waiting.push(message);
    }
    return { routed, waiting };
  }
}
