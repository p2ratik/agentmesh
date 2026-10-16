import { MeshError } from '@agentmesh/common';
import type { HubContext } from '../../context';
import type { HubModule, LeaseService, RpcHandlerMap } from '../../contracts';
import { internalId } from '../../core/ids';
import { LeaseServiceImpl } from './leases.service';

type LeaseHandlers = Pick<RpcHandlerMap, 'lease.acquire' | 'lease.release' | 'lease.list'>;

function leaseHandlers(leases: LeaseServiceImpl): LeaseHandlers {
  return {
    'lease.acquire': (params, call) =>
      leases.acquire({
        holder: call.actor.id,
        paths: params.paths,
        repo: params.repo ?? null,
        ttlMinutes: params.ttlMinutes ?? null,
        reason: params.reason ?? null,
        taskId: params.taskId ? internalId('task', params.taskId) : null,
      }),
    'lease.release': (params, call) => {
      if (!params.all && (!params.paths || params.paths.length === 0)) {
        throw new MeshError('invalid_request', 'Pass the paths to release, or all: true');
      }
      return { released: leases.release(call.actor.id, params.all ? null : (params.paths ?? [])) };
    },
    'lease.list': (params) => ({
      leases: leases.list({
        ...(params.holder ? { holder: params.holder } : {}),
        ...(params.repo ? { repo: params.repo } : {}),
      }),
    }),
  };
}

/** Advisory path leases with expiry. */
export function createLeaseModule(ctx: HubContext): HubModule<LeaseService> {
  const service = new LeaseServiceImpl(ctx);
  return {
    service,
    handlers: leaseHandlers(service),
    ticks: [{ name: 'leases.purge', run: (now) => void service.purgeExpired(now) }],
  };
}
