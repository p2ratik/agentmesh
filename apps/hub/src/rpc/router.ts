import type { RpcCallContext, RpcDispatcher } from '@agentmesh/bus';
import { type Logger, MeshError } from '@agentmesh/common';
import type { ConfigIndex } from '@agentmesh/config';
import {
  isRpcMethodName,
  type MethodDef,
  RPC_METHODS,
  type RpcMethodName,
} from '@agentmesh/protocol';
import type { Actor, CallContext, RpcHandler, RpcHandlerMap } from '../contracts';
import { resolveActAs, resolveCaller } from './actor';
import type { IdempotencyStore } from './idempotency';

export interface RouterDeps {
  /** Read on every call: enrolled members join and leave without a restart. */
  index: () => ConfigIndex;
  handlers: Partial<RpcHandlerMap>;
  idempotency: IdempotencyStore;
  logger: Logger;
  /** Called for every authenticated call (used to refresh presence). */
  onCall?: (caller: Actor) => void;
  /** Method definitions; defaults to the protocol's (tests override flags). */
  methods?: Record<RpcMethodName, MethodDef>;
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
    const def = (deps.methods ?? RPC_METHODS)[method];
    const { caller, actor } = authorize(deps.index(), def, ctx, method);
    const params = parseParams(def, method, rawParams);

    deps.onCall?.(caller);
    const call: CallContext = { actor, caller, method };
    const run = async () => handler(params as never, call);
    const key = ctx.idempotencyKey;
    if (!key) return run();
    return runOnce(deps.idempotency, caller.id, key, method, def.cacheResponse === false, run);
  };
}

/**
 * Runs a call at most once per (caller, key): replays or refuses a known key,
 * otherwise reserves it first. The lookup and the reservation happen in the
 * same tick, so no overlapping call can slip in between.
 */
async function runOnce(
  store: IdempotencyStore,
  callerId: string,
  key: string,
  method: RpcMethodName,
  withhold: boolean,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const cached = replayable(store, callerId, key, method);
  if (cached.found) return cached.response;
  store.reserve(callerId, key, method);
  let result: unknown;
  try {
    result = await run();
  } catch (error) {
    store.release(callerId, key, method);
    throw error;
  }
  store.put(callerId, key, method, result, { withhold });
  return result;
}

/** A stored response to replay, or a conflict when the response is pending or withheld. */
function replayable(
  store: IdempotencyStore,
  callerId: string,
  key: string,
  method: RpcMethodName,
): { found: false } | { found: true; response: unknown } {
  const cached = store.get(callerId, key, method);
  if (!cached.found) return cached;
  if (cached.pending) {
    throw new MeshError('conflict', `${method} is still running for this idempotency key`);
  }
  if (cached.withheld) {
    throw new MeshError(
      'conflict',
      `${method} already completed for this idempotency key; its response is not stored, so it cannot be replayed`,
    );
  }
  return cached;
}

/** Resolves who is calling (and for whom) and checks they may call this method. */
function authorize(
  index: ConfigIndex,
  def: MethodDef,
  ctx: RpcCallContext,
  method: RpcMethodName,
): { caller: Actor; actor: Actor } {
  const caller = resolveCaller(index, ctx.caller);
  const actor = ctx.actAs ? resolveActAs(index, caller, ctx.actAs) : caller;
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
function parseParams(def: MethodDef, method: RpcMethodName, raw: unknown): unknown {
  const parsed = def.params.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new MeshError('invalid_request', `Invalid parameters for ${method}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
