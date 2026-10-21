import { randomBytes } from 'node:crypto';
import type { NatsConnection } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import {
  MAX_DELIVERY_MESSAGES,
  type MeshMessage,
  SessionAck,
  type SessionInbound,
  subjects,
} from '@agentmesh/protocol';
import type { SessionTransport } from './dispatcher';

/** NATS's default max_payload, for before the server's INFO arrives. */
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
/** Room for the `deliver` envelope around the messages. */
const ENVELOPE_BYTES = 1024;

/** Splits a batch, in order, into deliveries the protocol and the server accept. */
export function deliveryChunks(messages: MeshMessage[], maxBytes: number): MeshMessage[][] {
  const chunks: MeshMessage[][] = [];
  let chunk: MeshMessage[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (chunk.length === MAX_DELIVERY_MESSAGES || (chunk.length > 0 && bytes + size > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(message);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/**
 * Core NATS request/ack to one session (spec §3). Delivery is at-least-once: if
 * the plugin pushed but its ack was lost or late, the messages stay pending and
 * go out again, possibly to another session when they start a new conversation.
 */
export class NatsSessionTransport implements SessionTransport {
  readonly #nc: NatsConnection;
  readonly #subjects: ReturnType<typeof subjects>;
  readonly #logger: Logger;
  readonly #timeoutMs: number;

  constructor(nc: NatsConnection, prefix: string, logger: Logger, timeoutMs = 5000) {
    this.#nc = nc;
    this.#subjects = subjects(prefix);
    this.#logger = logger;
    this.#timeoutMs = timeoutMs;
  }

  /** The ids the session acked among those sent. Timeouts and no-responders throw. */
  async send(agentId: string, sessionId: string, messages: MeshMessage[]): Promise<string[]> {
    const maxBytes = (this.#nc.info?.max_payload ?? DEFAULT_MAX_PAYLOAD) - ENVELOPE_BYTES;
    const acked: string[] = [];
    // One request at a time keeps the order; a failure throws and the whole batch waits.
    for (const chunk of deliveryChunks(messages, maxBytes)) {
      acked.push(...(await this.#request(agentId, sessionId, chunk)));
    }
    return acked;
  }

  expired(agentId: string, sessionId: string): void {
    const body: SessionInbound = { type: 'expired' };
    this.#nc.publish(this.#subjects.session(agentId, sessionId), JSON.stringify(body));
    this.#logger.debug(
      { agent: agentId, session: sessionId },
      'told an unknown session to reconnect',
    );
  }

  async #request(agentId: string, sessionId: string, messages: MeshMessage[]): Promise<string[]> {
    const body: SessionInbound = { type: 'deliver', messages };
    // The hub picks the reply subject under the agent's ack subjects, the only ones it may answer on.
    const reply = await this.#nc.request(
      this.#subjects.session(agentId, sessionId),
      JSON.stringify(body),
      {
        timeout: this.#timeoutMs,
        noMux: true,
        reply: this.#subjects.ack(agentId, randomBytes(12).toString('hex')),
      },
    );
    const sent = new Set(messages.map((m) => m.id));
    return SessionAck.parse(reply.json()).delivered.filter((id) => sent.has(id));
  }
}
