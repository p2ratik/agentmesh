import type { ErrorPayload } from '@agentmesh/common';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const RpcRequestEnvelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  params: z.unknown(),
  /** Honored only for services allowed to act on behalf of humans. */
  actAs: z.string().optional(),
  /** Retrying a request with the same key returns the original result. */
  idempotencyKey: z.string().min(1).max(120).optional(),
});
export type RpcRequestEnvelope = z.infer<typeof RpcRequestEnvelope>;

export type RpcResponseEnvelope<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: ErrorPayload };
