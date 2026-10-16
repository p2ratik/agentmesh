import type { HubContext } from '../../context';
import type { ControlService, HubModule } from '../../contracts';
import { ControlServiceImpl } from './control.service';
import { type ControlDeps, controlHandlers } from './handlers';

export type { ControlDeps } from './handlers';

/** Kill switch, mesh status and bridge refs. */
export function createControlModule(ctx: HubContext, deps: ControlDeps): HubModule<ControlService> {
  const service = new ControlServiceImpl(ctx);
  return { service, handlers: controlHandlers(ctx, service, deps) };
}
