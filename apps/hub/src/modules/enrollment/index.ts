import type { HubContext } from '../../context';
import type { EnrollmentService, HubModule, RpcHandlerMap } from '../../contracts';
import { type EnrollmentDeps, EnrollmentServiceImpl } from './enrollment.service';

export type { EnrollmentDeps, InboxPort } from './enrollment.service';
export { withMembers } from './members';

type EnrollmentHandlers = Pick<
  RpcHandlerMap,
  'enrollment.invite' | 'enrollment.cancelInvite' | 'enrollment.remove' | 'enrollment.list'
>;

function enrollmentHandlers(enrollment: EnrollmentServiceImpl): EnrollmentHandlers {
  return {
    'enrollment.invite': (params, call) => enrollment.invite(params, call.actor),
    'enrollment.cancelInvite': (params) => enrollment.cancelInvite(params.inviteId),
    'enrollment.remove': (params, call) => enrollment.remove(params.humanId, call.actor),
    'enrollment.list': () => ({ members: enrollment.list() }),
  };
}

/**
 * The team registry: members who joined by invite instead of mesh.yaml.
 * Build it before every other module: it sets `ctx.index` to mesh.yaml plus
 * the active members.
 */
export function createEnrollmentModule(
  ctx: HubContext,
  deps: EnrollmentDeps,
): HubModule<EnrollmentService> {
  const service = new EnrollmentServiceImpl(ctx, deps);
  return { service, handlers: enrollmentHandlers(service) };
}
