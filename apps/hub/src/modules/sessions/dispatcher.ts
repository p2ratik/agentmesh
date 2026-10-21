import type { Logger } from '@agentmesh/common';
import type { MeshMessage } from '@agentmesh/protocol';
import type { MessagingService, SessionsService } from '../../contracts';
import type { DeliveryPort, DeliveryReceipt } from '../../ports';
import type { Route } from './routing';

export interface SessionTransport {
  /** Hands messages to one session; resolves with the ids it pushed into Claude Code. */
  send(agentId: string, sessionId: string, messages: MeshMessage[]): Promise<string[]>;
  /** Tells a plugin its session is gone so it says hello again. */
  expired(agentId: string, sessionId: string): void;
}

interface Routed {
  message: MeshMessage;
  route: Extract<Route, { kind: 'deliver' }>;
}

/**
 * The outbox's delivery port (spec §3). Routes each message to one session of
 * its agent, hands every session its batch at once, and returns the acked ids
 * with a `commit` that claims ownership and advances the read cursor. The
 * outbox runs that commit in the transaction that marks the rows published, so
 * "delivered", "read" and "owned" are one step. Messages the agent already read
 * (through `inbox` or `thread`) count as delivered without a push.
 */
export class SessionDispatcher implements DeliveryPort {
  readonly #sessions: SessionsService;
  readonly #messaging: MessagingService;
  readonly #transport: SessionTransport;
  readonly #logger: Logger;

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

  async deliver(agentId: string, messages: MeshMessage[]): Promise<DeliveryReceipt> {
    // Already read through inbox or thread: delivered, with nothing to push, claim or mark read.
    const seen = messages.filter((m) => this.#messaging.isRead(agentId, m.id)).map((m) => m.id);
    // No active, live session: every route would wait.
    if (!this.#sessions.hasReadySession(agentId)) return { delivered: seen };
    const unseen = messages.filter((m) => !seen.includes(m.id));
    const routed = this.#route(agentId, unseen);
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
    const ids = delivered.map((r) => r.message.id);
    return {
      delivered: [...seen, ...ids],
      commit: () => {
        for (const { message, route } of delivered) {
          this.#sessions.delivered(agentId, route.sessionId, message, route);
        }
        // markRead trusts its caller: only this agent, only what its sessions acked.
        this.#messaging.markRead(agentId, ids);
      },
    };
  }

  /** The ids the session acked, among those it was sent. */
  async #send(agentId: string, sessionId: string, batch: Routed[]): Promise<string[]> {
    const messages = batch.map((r) => r.message);
    const acked = new Set(await this.#transport.send(agentId, sessionId, messages));
    return messages.filter((m) => acked.has(m.id)).map((m) => m.id);
  }

  /**
   * In order. A thread's later messages follow its first one in this call: they
   * wait with it, or go to its session (claims commit only after the sends, so
   * routing them afresh could split a new thread across sessions).
   */
  #route(agentId: string, messages: MeshMessage[]): Routed[] {
    const firstOfThread = new Map<string, Route>();
    const routed: Routed[] = [];
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
    }
    return routed;
  }
}

/** A later message of a thread, in the same call, goes where the thread's first one went. */
function follow(first: Route): Route {
  if (first.kind === 'wait')
    return { kind: 'wait', reason: 'an earlier message of its thread waits' };
  const { sessionId } = first;
  return {
    kind: 'deliver',
    sessionId,
    claim: false,
    reason: `its thread goes to ${sessionId} in this batch`,
  };
}
