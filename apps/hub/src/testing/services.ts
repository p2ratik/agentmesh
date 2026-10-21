import type { LoadedConfig } from '@agentmesh/config';
import type { MeshMessage } from '@agentmesh/protocol';
import type { MessagingService, PresenceService, SessionsService } from '../contracts';
import { createControlModule } from '../modules/control';
import { createMessagingModule } from '../modules/messaging';
import { createPresenceModule } from '../modules/presence';
import { createSessionsModule } from '../modules/sessions';
import { SessionDispatcher } from '../modules/sessions/dispatcher';
import type { DeliveryPort } from '../ports';
import { FakeLeases, FakeTransport } from './fakes';
import { createTestHarness, type TestHarness } from './harness';

export interface ServiceHarness extends TestHarness {
  messaging: MessagingService;
  presence: PresenceService;
  leases: FakeLeases;
  /** Flushes the outbox and returns what each agent received since the last call. */
  drain(): Promise<Map<string, MeshMessage[]>>;
}

/**
 * Real control, presence and messaging over an in-memory database, with fake
 * leases. For testing modules that sit on top of messaging (tasks, planning,
 * ingest) through the real delivery path.
 */
export function createServiceHarness(
  loaded?: LoadedConfig,
  options: { online?: string[]; delivery?: DeliveryPort } = {},
): ServiceHarness {
  const base = createTestHarness(loaded, options.delivery);
  const control = createControlModule(base.ctx, {
    peers: () => [],
    counts: () => ({ openThreads: 0, openTasks: 0, activePlans: 0 }),
  }).service;
  const presence = createPresenceModule(base.ctx).service;
  // No sessions module here: every `toSession` pick is refused.
  const messaging = createMessagingModule(base.ctx, {
    control,
    presence,
    isActiveSessionOf: () => false,
  }).service;
  for (const id of options.online ?? []) presence.touch(id);
  let seen = 0;
  return {
    ...base,
    messaging,
    presence,
    leases: new FakeLeases(),
    async drain() {
      await base.outbox.flush();
      const fresh = base.ports.deliveries.slice(seen);
      seen = base.ports.deliveries.length;
      const byRecipient = new Map<string, MeshMessage[]>();
      for (const d of fresh) {
        byRecipient.set(d.recipientId, [...(byRecipient.get(d.recipientId) ?? []), d.message]);
      }
      return byRecipient;
    },
  };
}

export interface DispatchHarness extends ServiceHarness {
  sessions: SessionsService;
  transport: FakeTransport;
  dispatcher: SessionDispatcher;
}

/**
 * The service harness plus the real sessions module. The outbox delivers
 * through a SessionDispatcher over a FakeTransport, as production does over NATS.
 */
export function createDispatchHarness(): DispatchHarness {
  const transport = new FakeTransport();
  // Built once the services it routes with exist; the outbox only calls it on flush.
  let dispatcher: SessionDispatcher | null = null;
  const h = createServiceHarness(undefined, {
    delivery: {
      deliver: (agentId, messages) => {
        if (!dispatcher) throw new Error('dispatcher not built yet');
        return dispatcher.deliver(agentId, messages);
      },
    },
  });
  const sessions = createSessionsModule(h.ctx, {
    messaging: h.messaging,
    presence: h.presence,
    locate: () => null,
    threadOf: () => null,
  }).service;
  dispatcher = new SessionDispatcher({
    sessions,
    messaging: h.messaging,
    transport,
    logger: h.ctx.logger,
  });
  return { ...h, sessions, transport, dispatcher };
}
