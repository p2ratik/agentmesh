import { type Logger, toErrorPayload } from '@agentmesh/common';
import {
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

async function handle(msg: Msg, dispatch: RpcDispatcher, options: ServeRpcOptions): Promise<void> {
  const route = parseRpcSubject(options.prefix, msg.subject);
  if (!route || !msg.reply) return;
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
  try {
    msg.respond(JSON.stringify(response));
  } catch (error) {
    options.logger.warn({ err: error, method: route.method }, 'failed to send rpc response');
  }
}
