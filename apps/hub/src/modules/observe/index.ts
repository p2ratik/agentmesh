import type { HubContext } from '../../context';
import type { HubModule } from '../../contracts';
import { ObserveService } from './observe.service';

/** The event store behind `telemetry.report` (and the timeline, added with its reader). */
export function createObserveModule(ctx: HubContext): HubModule<ObserveService> {
  const service = new ObserveService(ctx);
  return {
    service,
    handlers: {
      'telemetry.report': (params, call) => service.report(call.actor.id, params.events),
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
