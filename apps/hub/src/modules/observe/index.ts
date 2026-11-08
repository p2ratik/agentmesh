import type { HubContext } from '../../context';
import type { HubModule } from '../../contracts';
import { ObserveService } from './observe.service';

/** The event store behind `telemetry.report` and `observe.timeline`, for operators. */
export function createObserveModule(
  ctx: HubContext,
  deps: { ownsSession: (agent: string, session: string) => boolean },
): HubModule<ObserveService> {
  const service = new ObserveService(ctx, deps.ownsSession);
  return {
    service,
    handlers: {
      'telemetry.report': (params, call) => service.report(call.actor.id, params.events),
      'observe.timeline': (params, call) => service.timeline(call.actor.id, params),
    },
    ticks: [
      {
        name: 'observe.prune',
        run: (now) => {
          const pruned = service.prune(now);
          if (pruned) ctx.logger.debug({ pruned }, 'old events deleted');
        },
      },
    ],
  };
}
