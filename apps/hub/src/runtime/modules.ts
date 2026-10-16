import type { HubContext } from '../context';
import type {
  ControlService,
  HubModule,
  IngestService,
  LeaseService,
  MessagingService,
  PlanningService,
  PresenceService,
  RpcHandlerMap,
  TaskService,
  TickJob,
} from '../contracts';
import { createControlModule } from '../modules/control';
import { createIngestModule, type IngestTransport } from '../modules/ingest';
import { createLeaseModule } from '../modules/leases';
import { createMessagingModule, type MessagingModule } from '../modules/messaging';
import { createPlanningModule } from '../modules/planning';
import { createPresenceModule } from '../modules/presence';
import { createTaskModule } from '../modules/tasks';

export interface HubServices {
  control: ControlService;
  presence: PresenceService;
  messaging: MessagingService;
  leases: LeaseService;
  tasks: TaskService;
  planning: PlanningService;
  ingest: IngestService;
}

export interface BuiltModules {
  services: HubServices;
  /** In start order; stop runs in reverse. */
  modules: Array<HubModule<unknown>>;
  handlers: Partial<RpcHandlerMap>;
  ticks: TickJob[];
}

/**
 * Builds every module in dependency order. Cycles (control needs counts from
 * later modules; presence needs unread counts and task load) are closed with
 * callbacks that only run after construction.
 */
export function buildModules(ctx: HubContext, transport: IngestTransport | null): BuiltModules {
  let messaging: MessagingModule | null = null;
  let tasks: TaskService | null = null;
  let planning: PlanningService | null = null;

  const presence = createPresenceModule(ctx, {
    unreadThreadCount: (id) => messaging?.service.unreadThreadCount(id) ?? 0,
  });
  const control = createControlModule(ctx, {
    peers: () => presence.service.peers('all'),
    counts: () => ({
      openThreads: messaging?.openThreadCount() ?? 0,
      openTasks: tasks?.openCount() ?? 0,
      activePlans: planning?.activeCount() ?? 0,
    }),
  });
  messaging = createMessagingModule(ctx, { control: control.service, presence: presence.service });
  const leases = createLeaseModule(ctx);
  const taskModule = createTaskModule(ctx, {
    messaging: messaging.service,
    presence: presence.service,
    leases: leases.service,
  });
  tasks = taskModule.service;
  presence.service.setLoadReader(() => taskModule.service.activeLoad());
  const planningModule = createPlanningModule(ctx, {
    messaging: messaging.service,
    tasks,
    presence: presence.service,
  });
  planning = planningModule.service;
  const ingest = createIngestModule(ctx, {
    messaging: messaging.service,
    tasks,
    presence: presence.service,
    transport,
  });

  const modules: Array<HubModule<unknown>> = [
    control,
    presence,
    messaging,
    leases,
    taskModule,
    planningModule,
    ingest,
  ];
  return {
    services: {
      control: control.service,
      presence: presence.service,
      messaging: messaging.service,
      leases: leases.service,
      tasks,
      planning,
      ingest: ingest.service,
    },
    modules,
    handlers: Object.assign({}, ...modules.map((m) => m.handlers)),
    ticks: modules.flatMap((m) => m.ticks ?? []),
  };
}
