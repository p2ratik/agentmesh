import type { Actor, TaskCreateInput } from '../contracts';
import { TaskServiceImpl } from '../modules/tasks/tasks.service';
import { createServiceHarness } from './services';

export const agent = (id: string): Actor => ({ id, kind: 'agent', roles: [] });
export const human = (id: string): Actor => ({ id, kind: 'human', roles: [] });

/** A plain task to spread and override. */
export const baseTask: TaskCreateInput = {
  title: 'Add retries to the queue consumer',
  description: 'Exponential backoff, idempotency key.',
  priority: 'normal',
  labels: [],
  dependsOn: [],
};

/** The service harness plus a real task service; the agents in `online` are present. */
export function createTaskHarness(online = ['alice-agent', 'bob-agent', 'carol-agent']) {
  const h = createServiceHarness(undefined, { online });
  const tasks = new TaskServiceImpl(h.ctx, {
    messaging: h.messaging,
    presence: h.presence,
    leases: h.leases,
  });
  h.presence.setLoadReader(() => tasks.activeLoad());
  return { ...h, tasks };
}
