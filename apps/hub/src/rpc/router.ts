import type { RpcCallContext, RpcDispatcher } from '@agentmesh/bus';
import { type Logger, MeshError } from '@agentmesh/common';
import type { ConfigIndex } from '@agentmesh/config';
import { isRpcMethodName, RPC_METHODS, type RpcMethodName } from '@agentmesh/protocol';
import type { Actor, CallContext, RpcHandler, RpcHandlerMap } from '../contracts';
import { resolveActAs, resolveCaller } from './actor';
import type { IdempotencyStore } from './idempotency';

export interface RouterDeps {
  index: ConfigIndex;
  handlers: Partial<RpcHandlerMap>;
  idempotency: IdempotencyStore;
  logger: Logger;
  /** Called for every authenticated call (used to refresh presence). */
  onCall?: (caller: Actor) => void;
}

/**
 * Turns raw RPC calls into validated, authorized handler invocations.
 * Order: method → caller → actAs → caller kind → role → params → idempotency.
 */
export function createRpcRouter(deps: RouterDeps): RpcDispatcher {
  return async (ctx: RpcCallContext, rawParams: unknown) => {
    if (!isRpcMethodName(ctx.method)) {
      throw new MeshError('not_found', `Unknown method "${ctx.method}"`);
    }
    const method: RpcMethodName = ctx.method;
    const handler = deps.handlers[method] as RpcHandler<RpcMethodName> | undefined;
    if (!handler) {
      throw new MeshError('not_found', `Method "${method}" is not available on this hub`);
    }
    const { caller, actor } = authorize(deps, ctx, method);
    const params = parseParams(method, rawParams);

    deps.onCall?.(caller);
    const key = ctx.idempotencyKey;
    if (key) {
      const cached = deps.idempotency.get(caller.id, key, method);
      if (cached.found) return cached.response;
    }
    const call: CallContext = { actor, caller, method };
    const result = await handler(params as never, call);
    if (key) deps.idempotency.put(caller.id, key, method, result);
    return result;
  };
}

/** Resolves who is calling (and for whom) and checks they may call this method. */
function authorize(
  deps: RouterDeps,
  ctx: RpcCallContext,
  method: RpcMethodName,
): { caller: Actor; actor: Actor } {
  const def = RPC_METHODS[method];
  const caller = resolveCaller(deps.index, ctx.caller);
  const actor = ctx.actAs ? resolveActAs(deps.index, caller, ctx.actAs) : caller;
  const callers: readonly string[] = def.callers;
  if (!callers.includes(actor.kind)) {
    throw new MeshError('forbidden', `${actor.kind}s may not call ${method}`);
  }
  if (def.requiresRole && !actor.roles.includes(def.requiresRole)) {
    throw new MeshError('forbidden', `${method} requires the "${def.requiresRole}" role`);
  }
  return { caller, actor };
}

/** Validates params against the method's schema and applies its defaults. */
function parseParams(method: RpcMethodName, raw: unknown): unknown {
  const parsed = RPC_METHODS[method].params.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new MeshError('invalid_request', `Invalid parameters for ${method}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
