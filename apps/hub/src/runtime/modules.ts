import type { HubContext } from '../context';
import type {
  ControlService,
  EnrollmentService,
  HubModule,
  IngestService,
  LeaseService,
  MessagingService,
  PlanningService,
  PresenceService,
  RpcHandlerMap,
  SessionsService,
  TaskService,
  TickJob,
} from '../contracts';
import { createControlModule } from '../modules/control';
import { createEnrollmentModule } from '../modules/enrollment';
import { createIngestModule, type IngestTransport } from '../modules/ingest';
import { createLeaseModule } from '../modules/leases';
import { createMessagingModule, type MessagingModule } from '../modules/messaging';
import { createPlanningModule } from '../modules/planning';
import { createPresenceModule } from '../modules/presence';
import { createSessionsModule } from '../modules/sessions';
import type { SessionTransport } from '../modules/sessions/dispatcher';
import { createTaskModule } from '../modules/tasks';

export interface HubServices {
  enrollment: EnrollmentService;
  control: ControlService;
  presence: PresenceService;
  messaging: MessagingService;
  sessions: SessionsService;
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
 * Builds every module in dependency order. Enrollment comes first because it
 * sets `ctx.index`. Cycles (control needs counts from later modules; presence
 * needs task load and sessions; messaging checks session picks; sessions locate
 * tasks and plans) are closed with callbacks that only run after construction.
 */
export function buildModules(
  ctx: HubContext,
  transport: IngestTransport | null,
  nats: {
    kick: ((agentId: string) => Promise<void>) | null;
    /** Reaches sessions for activation checks; absent without NATS. */
    sessionTransport?: Pick<SessionTransport, 'check'> | null;
  },
): BuiltModules {
  let messaging: MessagingModule | null = null;
  let sessions: SessionsService | null = null;
  let tasks: TaskService | null = null;
  let planning: PlanningService | null = null;
  let presenceService: PresenceService | null = null;

  const enrollment = createEnrollmentModule(ctx, {
    kick: nats.kick,
    onMembersChanged: () => presenceService?.syncFromConfig(),
  });
  const presence = createPresenceModule(ctx);
  presenceService = presence.service;
  const control = createControlModule(ctx, {
    peers: () => presence.service.peers('all'),
    counts: () => ({
      openThreads: messaging?.openThreadCount() ?? 0,
      openTasks: tasks?.openCount() ?? 0,
      activePlans: planning?.activeCount() ?? 0,
    }),
  });
  messaging = createMessagingModule(ctx, {
    control: control.service,
    presence: presence.service,
    isActiveSessionOf: (agentId, sessionId) =>
      sessions?.activeSessions(agentId).some((s) => s.id === sessionId) ?? false,
  });
  const sessionsModule = createSessionsModule(ctx, {
    messaging: messaging.service,
    presence: presence.service,
    locate: (taskId) => tasks?.locate(taskId) ?? null,
    threadOf: (planId) => planning?.threadOf(planId) ?? null,
    transport: nats.sessionTransport ?? null,
  });
  sessions = sessionsModule.service;
  messaging.service.setOwnerReader((threadId, agentId) => {
    const sessionId = sessionsModule.service.effectiveOwner(threadId, agentId);
    if (sessionId === null) return null;
    // Owners are never closed: closing a session releases what it owns.
    const away = sessionsModule.service.verify(agentId, sessionId).liveness === 'away';
    return { sessionId, liveness: away ? 'away' : 'live' };
  });
  presence.service.setSessionReader((agentId) => sessionsModule.service.activeSessions(agentId));
  presence.service.setReadyReader((agentId) => sessionsModule.service.reach(agentId));
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
    enrollment,
    control,
    presence,
    messaging,
    sessionsModule,
    leases,
    taskModule,
    planningModule,
    ingest,
  ];
  return {
    services: {
      enrollment: enrollment.service,
      control: control.service,
      presence: presence.service,
      messaging: messaging.service,
      sessions,
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
