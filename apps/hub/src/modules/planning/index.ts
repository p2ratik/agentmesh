import { MeshError } from '@agentmesh/common';
import type { HubContext } from '../../context';
import type { HubModule, PlanningService, RpcHandlerMap } from '../../contracts';
import { internalId } from '../../core/ids';
import type { PlanningDeps } from './flow';
import { PlanningServiceImpl } from './planning.service';

export type { PlanningDeps } from './flow';

type PlanHandlers = Pick<
  RpcHandlerMap,
  | 'plan.start'
  | 'plan.get'
  | 'plan.list'
  | 'plan.contribute'
  | 'plan.submit'
  | 'plan.approve'
  | 'plan.cancel'
>;

const planId = (raw: string) => internalId('plan', raw);

function planHandlers(planning: PlanningServiceImpl): PlanHandlers {
  return {
    'plan.start': (params, call) => planning.start(params, call.actor),
    'plan.get': (params) => {
      const id = planId(params.planId);
      return { plan: planning.get(id), contributions: planning.contributions(id) };
    },
    'plan.list': (params) => ({ plans: planning.list(params.state ?? null, params.limit) }),
    'plan.contribute': (params, call) =>
      planning.contribute(planId(params.planId), params.body, call.actor),
    'plan.submit': (params, call) =>
      planning.submit(planId(params.planId), params.summary, params.tasks, call.actor),
    'plan.approve': (params, call) => {
      if (call.actor.kind !== 'human')
        throw new MeshError('forbidden', 'Only humans approve plans');
      return planning.approve(planId(params.planId));
    },
    'plan.cancel': (params, call) =>
      planning.cancel(planId(params.planId), params.reason ?? null, call.actor),
  };
}

/** Team planning sessions driven by `/plan` or `plan_start`. */
export function createPlanningModule(
  ctx: HubContext,
  deps: PlanningDeps,
): HubModule<PlanningService> {
  const service = new PlanningServiceImpl(ctx, deps);
  return {
    service,
    handlers: planHandlers(service),
    ticks: [{ name: 'planning.deadlines', run: (now) => service.tick(now) }],
  };
}
