import { MeshError } from '@agentmesh/common';
import type { PeerInfo } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { CallContext, ControlService, RpcHandlerMap } from '../../contracts';

export interface ControlDeps {
  peers(): PeerInfo[];
  counts(): { openThreads: number; openTasks: number; activePlans: number };
}

type ControlHandlers = Pick<
  RpcHandlerMap,
  'mesh.status' | 'mesh.pause' | 'mesh.resume' | 'refs.set' | 'refs.get' | 'refs.find'
>;

/** Refs are bridge bookkeeping; other services have no reason to touch them. */
function assertBridge(call: CallContext): void {
  if (!call.caller.roles.includes('bridge')) {
    throw new MeshError('forbidden', `${call.method} is only available to bridge services`);
  }
}

export function controlHandlers(
  ctx: HubContext,
  control: ControlService,
  deps: ControlDeps,
): ControlHandlers {
  return {
    'mesh.status': () => ({
      name: ctx.loaded.config.mesh.name,
      paused: control.isPaused(),
      pausedReason: control.pausedReason(),
      peers: deps.peers(),
      counts: { ...deps.counts(), heldDeliveries: ctx.outbox.heldCount() },
    }),
    'mesh.pause': (params, call) => {
      control.pause(call.actor.id, params.reason ?? null);
      return { paused: true };
    },
    'mesh.resume': (_params, call) => ({ paused: false, released: control.resume(call.actor.id) }),
    'refs.set': (params, call) => {
      assertBridge(call);
      control.setRef(params.system, params.entityType, params.entityId, params.ref);
      return { ok: true };
    },
    'refs.get': (params, call) => {
      assertBridge(call);
      return { ref: control.getRef(params.system, params.entityType, params.entityId) };
    },
    'refs.find': (params, call) => {
      assertBridge(call);
      return { entity: control.findRef(params.system, params.ref) };
    },
  };
}
