import { MeshError } from '@agentmesh/common';
import {
  PROTOCOL_VERSION,
  RPC_METHODS,
  type RpcMethodName,
  type RpcParamsInput,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
  type RpcResult,
  subjects,
} from '@agentmesh/protocol';
import type { NatsConnection } from '@nats-io/transport-node';

export interface CallOptions {
  idempotencyKey?: string;
  /** Services allowed to act for humans pass the human id here. */
  actAs?: string;
  timeoutMs?: number;
}

/** Typed client for the hub's RPC surface. One instance per participant. */
export class RpcClient {
  readonly #nc: NatsConnection;
  readonly #subjects: ReturnType<typeof subjects>;
  readonly #caller: string;
  readonly #timeoutMs: number;

  constructor(nc: NatsConnection, prefix: string, callerId: string, timeoutMs = 15_000) {
    this.#nc = nc;
    this.#subjects = subjects(prefix);
    this.#caller = callerId;
    this.#timeoutMs = timeoutMs;
  }

  async call<M extends RpcMethodName>(
    method: M,
    params: RpcParamsInput<M>,
    options: CallOptions = {},
  ): Promise<RpcResult<M>> {
    const envelope: RpcRequestEnvelope = {
      v: PROTOCOL_VERSION,
      params,
      ...(options.actAs ? { actAs: options.actAs } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    };
    let reply: { json<T>(): T };
    try {
      reply = await this.#nc.request(
        this.#subjects.rpc(this.#caller, method),
        JSON.stringify(envelope),
        {
          timeout: options.timeoutMs ?? this.#timeoutMs,
        },
      );
    } catch (error) {
      throw translateTransportError(error);
    }
    const response = reply.json<RpcResponseEnvelope>();
    if (!response.ok) throw MeshError.fromPayload(response.error);
    return RPC_METHODS[method].result.parse(response.result) as RpcResult<M>;
  }
}

function translateTransportError(error: unknown): MeshError {
  const text = `${(error as Error)?.name ?? ''} ${(error as Error)?.message ?? ''}`.toLowerCase();
  if (text.includes('no responders') || text.includes('503')) {
    return new MeshError('unavailable', 'The mesh hub is not reachable right now.');
  }
  if (text.includes('timeout'))
    return new MeshError('timeout', 'The mesh hub did not answer in time.');
  if (text.includes('permission'))
    return new MeshError('forbidden', 'NATS permissions rejected the request.');
  return new MeshError(
    'unavailable',
    `Mesh transport error: ${(error as Error)?.message ?? 'unknown'}`,
  );
}
