import type { RpcClient } from '@agentmesh/bus';
import type { RpcMethodName, RpcParamsInput, RpcResult } from '@agentmesh/protocol';

/** The slice of the RPC client the bridge uses; lets tests pass a fake. */
export type MeshRpc = Pick<RpcClient, 'call'>;

/** An RPC call already bound to the human it is made for. */
export type HumanCall = <M extends RpcMethodName>(
  method: M,
  params: RpcParamsInput<M>,
) => Promise<RpcResult<M>>;

/**
 * Binds calls to a configured human (`actAs`) and to one Discord action's id,
 * so a retried interaction never applies twice on the hub. The key is per
 * method, so one interaction can make several calls (an invite, then its
 * cancellation) without one replaying or clobbering another.
 */
export function actAs(rpc: MeshRpc, humanId: string, interactionId: string): HumanCall {
  return (method, params) =>
    rpc.call(method, params, { actAs: humanId, idempotencyKey: `${interactionId}:${method}` });
}
