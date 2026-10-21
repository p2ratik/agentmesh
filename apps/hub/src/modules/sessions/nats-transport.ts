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

const byteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** The message with its body cut to fit `maxBytes`; the hub keeps the full text. */
function clipToFit(message: MeshMessage, maxBytes: number): MeshMessage {
  const note = `\n… _(truncated: call thread(thread_id: "${message.threadId}") for the full text)_`;
  const fits = (n: number) =>
    byteSize({ ...message, body: message.body.slice(0, n) + note }) < maxBytes;
  // JSON escaping makes a character 1 to 6 bytes, so search for the longest prefix that fits.
  let [lo, hi] = [0, message.body.length];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { ...message, body: message.body.slice(0, lo) + note };
}

/**
 * Splits a batch, in order, into deliveries the protocol and the server accept.
 * A message too big for a delivery on its own is clipped to fit.
 */
export function deliveryChunks(messages: MeshMessage[], maxBytes: number): MeshMessage[][] {
  const chunks: MeshMessage[][] = [];
  let chunk: MeshMessage[] = [];
  let bytes = 0;
  for (const whole of messages) {
    const message = byteSize(whole) < maxBytes ? whole : clipToFit(whole, maxBytes);
    const size = byteSize(message) + 1;
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

  /**
   * The ids the session acked among those sent, one request at a time to keep
   * the order. A failed first request throws (timeouts, no-responders); a later
   * one stops the batch and keeps what got through, the rest waits.
   */
  async send(agentId: string, sessionId: string, messages: MeshMessage[]): Promise<string[]> {
    const maxPayload = this.#nc.info?.max_payload ?? DEFAULT_MAX_PAYLOAD;
    const acked: string[] = [];
    const chunks = deliveryChunks(messages, maxPayload - ENVELOPE_BYTES);
    for (const [i, chunk] of chunks.entries()) {
      try {
        acked.push(...(await this.#request(agentId, sessionId, chunk, maxPayload)));
      } catch (err) {
        if (i === 0) throw err;
        this.#logger.warn(
          { agent: agentId, session: sessionId, err, sent: i, of: chunks.length },
          'delivery stopped part way; the rest waits',
        );
        break;
      }
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

  async #request(
    agentId: string,
    sessionId: string,
    messages: MeshMessage[],
    maxPayload: number,
  ): Promise<string[]> {
    const body: SessionInbound = { type: 'deliver', messages };
    const payload = JSON.stringify(body);
    // nats.js leaves a timer behind when a noMux request is too big, and its rejection kills the hub.
    if (Buffer.byteLength(payload) > maxPayload) throw new Error('delivery over max_payload');
    // The hub picks the reply subject under the agent's ack subjects, the only ones it may answer on.
    const reply = await this.#nc.request(this.#subjects.session(agentId, sessionId), payload, {
      timeout: this.#timeoutMs,
      noMux: true,
      reply: this.#subjects.ack(agentId, randomBytes(12).toString('hex')),
    });
    const sent = new Set(messages.map((m) => m.id));
    return SessionAck.parse(reply.json()).delivered.filter((id) => sent.has(id));
  }
}
