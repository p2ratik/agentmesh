import type { HubContext } from '../../context';
import type { HubModule, TaskService } from '../../contracts';
import { taskHandlers } from './handlers';
import { TaskServiceImpl } from './tasks.service';
import type { TaskModuleDeps } from './types';

export type { TaskModuleDeps } from './types';

/** Tasks, configurable workflows, routing and reviews. */
export function createTaskModule(ctx: HubContext, deps: TaskModuleDeps): HubModule<TaskService> {
  const service = new TaskServiceImpl(ctx, deps);
  return { service, handlers: taskHandlers(service) };
}
