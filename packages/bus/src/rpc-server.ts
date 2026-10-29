import { type Logger, toErrorPayload } from '@agentmesh/common';
import {
  inboxPrefix,
  parseRpcSubject,
  RpcRequestEnvelope,
  type RpcResponseEnvelope,
  subjects,
} from '@agentmesh/protocol';
import type { Msg, NatsConnection, Subscription } from '@nats-io/transport-node';

export interface RpcCallContext {
  /** Authenticated by NATS subject permissions: callers can only publish under their own id. */
  caller: string;
  method: string;
  actAs?: string;
  idempotencyKey?: string;
  /** The calling Claude Code session, when the plugin sent one. */
  session?: string;
  /** Advisory messages for the caller; serveRpc returns them in the ok response. */
  notes?: string[];
}

export type RpcDispatcher = (ctx: RpcCallContext, params: unknown) => Promise<unknown>;

export interface ServeRpcOptions {
  prefix: string;
  /** Queue group so several hub replicas can share the load. */
  queue?: string;
  logger: Logger;
}

/** Subscribes to every RPC subject and answers with a response envelope. */
export function serveRpc(
  nc: NatsConnection,
  dispatch: RpcDispatcher,
  options: ServeRpcOptions,
): Subscription {
  const subs = subjects(options.prefix);
  return nc.subscribe(subs.rpcAll, {
    queue: options.queue ?? 'hub',
    callback: (err, msg) => {
      if (err) {
        options.logger.error({ err }, 'rpc subscription error');
        return;
      }
      void handle(msg, dispatch, options);
    },
  });
}

/**
 * NATS does not check a request's reply subject against the publisher's permissions, and the
 * hub may publish anywhere, so it answers only into the caller's own inbox. Otherwise a member
 * could aim the hub's response at another agent's presence subject or at the event stream. Pure.
 */
export function isOwnInbox(caller: string, reply: string): boolean {
  return reply.startsWith(`${inboxPrefix(caller)}.`);
}

async function handle(msg: Msg, dispatch: RpcDispatcher, options: ServeRpcOptions): Promise<void> {
  const route = parseRpcSubject(options.prefix, msg.subject);
  if (!route || !msg.reply) return;
  if (!isOwnInbox(route.caller, msg.reply)) {
    options.logger.warn(
      { caller: route.caller, method: route.method },
      'rpc reply subject is not the caller inbox; not answered',
    );
    return;
  }
  const response = await answer(msg, route, dispatch, options);
  try {
    msg.respond(JSON.stringify(response));
  } catch (error) {
    options.logger.warn({ err: error, method: route.method }, 'failed to send rpc response');
  }
}

async function answer(
  msg: Msg,
  route: { caller: string; method: string },
  dispatch: RpcDispatcher,
  options: ServeRpcOptions,
): Promise<RpcResponseEnvelope> {
  let response: RpcResponseEnvelope;
  try {
    const envelope = RpcRequestEnvelope.safeParse(msg.json());
    if (!envelope.success) {
      response = {
        ok: false,
        error: { code: 'invalid_request', message: 'Malformed RPC envelope' },
      };
    } else {
      const { params, actAs, idempotencyKey, session } = envelope.data;
      const notes: string[] = [];
      const ctx: RpcCallContext = {
        caller: route.caller,
        method: route.method,
        notes,
        ...(actAs ? { actAs } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(session ? { session } : {}),
      };
      const result = await dispatch(ctx, params);
      response = { ok: true, result, ...(notes.length > 0 ? { notes } : {}) };
    }
  } catch (error) {
    const payload = toErrorPayload(error);
    if (payload.code === 'internal') {
      options.logger.error(
        { err: error, method: route.method, caller: route.caller },
        'rpc handler failed',
      );
    }
    response = { ok: false, error: payload };
  }
  return response;
}
