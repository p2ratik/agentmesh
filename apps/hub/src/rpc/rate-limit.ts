import { MeshError } from '@agentmesh/common';
import type { RpcMethodName } from '@agentmesh/protocol';
import type { Actor } from '../contracts';

/**
 * Methods that create nothing and reach nobody else: reads, plus a session's own
 * read markers and goodbye. Every other method costs a token, new ones included.
 */
const FREE: ReadonlySet<RpcMethodName> = new Set<RpcMethodName>([
  'peers.list',
  'mesh.status',
  'thread.get',
  'thread.list',
  'inbox.get',
  'messages.seen',
  'session.bye',
  'task.get',
  'task.list',
  'plan.get',
  'plan.list',
  'lease.list',
  'refs.get',
  'refs.find',
  'enrollment.list',
]);

export interface RateLimits {
  rpcBurst: number;
  rpcPerMinute: number;
}

/**
 * Per-actor token buckets for state-changing calls: `rpcBurst` at once, refilled
 * at `rpcPerMinute`. Keyed by the actor, so each human the bridge acts for has
 * their own. Services acting as themselves (the bridge's refs, enrollment) are
 * configured by an admin and not metered. In memory: a restart refills every bucket.
 */
export class RpcRateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  /** Spends one token or throws `rate_limited`. `now` in ms. */
  take(actor: Actor, method: RpcMethodName, limits: RateLimits, now: number): void {
    if (actor.kind === 'service' || FREE.has(method)) return;
    const perMs = limits.rpcPerMinute / 60_000;
    const bucket = this.#buckets.get(actor.id) ?? { tokens: limits.rpcBurst, at: now };
    const tokens = Math.min(limits.rpcBurst, bucket.tokens + (now - bucket.at) * perMs);
    if (tokens < 1) {
      this.#buckets.set(actor.id, { tokens, at: now });
      const retryAfterSeconds = Math.ceil((1 - tokens) / perMs / 1000);
      throw new MeshError(
        'rate_limited',
        `Too many calls: ${limits.rpcBurst} at once, then ${limits.rpcPerMinute} a minute. ` +
          `Try again in ${retryAfterSeconds}s.`,
        { limit: limits.rpcPerMinute, window: 'minute', retryAfterSeconds },
      );
    }
    this.#buckets.set(actor.id, { tokens: tokens - 1, at: now });
  }
}
