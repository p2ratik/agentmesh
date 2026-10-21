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
 * "delivered", "read" and "owned" are one step.
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
    const routed = this.#route(agentId, messages);
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
      delivered: ids,
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

  /** In order; once a message of a thread waits, the later ones of that thread wait too. */
  #route(agentId: string, messages: MeshMessage[]): Routed[] {
    const waiting = new Set<string>();
    const routed: Routed[] = [];
    for (const message of messages) {
      const route: Route = waiting.has(message.threadId)
        ? { kind: 'wait', reason: 'an earlier message of its thread waits' }
        : this.#sessions.route(agentId, message);
      const session = route.kind === 'deliver' ? route.sessionId : null;
      this.#logger.debug(
        { agent: agentId, message: message.id, session, reason: route.reason },
        'delivery routed',
      );
      if (route.kind === 'deliver') routed.push({ message, route });
      else waiting.add(message.threadId);
    }
    return routed;
  }
}
