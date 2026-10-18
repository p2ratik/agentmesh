import type { z } from 'zod';
import { adminMethods } from './admin';
import { enrollmentMethods } from './enrollment';
import { leaseMethods } from './leases';
import { messagingMethods } from './messaging';
import { planningMethods } from './planning';
import { sessionMethods } from './session';
import { taskMethods } from './tasks';

export * from './define';
export * from './envelope';
export { TaskCreateParams } from './tasks';

export const RPC_METHODS = {
  ...sessionMethods,
  ...messagingMethods,
  ...taskMethods,
  ...planningMethods,
  ...leaseMethods,
  ...adminMethods,
  ...enrollmentMethods,
} as const;

export type RpcMethods = typeof RPC_METHODS;
export type RpcMethodName = keyof RpcMethods;
/** What a caller sends (defaults not yet applied). */
export type RpcParamsInput<M extends RpcMethodName> = z.input<RpcMethods[M]['params']>;
/** What a handler receives (after validation and defaults). */
export type RpcParams<M extends RpcMethodName> = z.output<RpcMethods[M]['params']>;
export type RpcResult<M extends RpcMethodName> = z.output<RpcMethods[M]['result']>;

export function isRpcMethodName(name: string): name is RpcMethodName {
  return Object.hasOwn(RPC_METHODS, name);
}
