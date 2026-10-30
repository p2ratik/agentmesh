import type { LoadedConfig } from '@agentmesh/config';
import type { MessageRefs, SessionDelivery } from '@agentmesh/protocol';
import type {
  ControlService,
  MessagingService,
  PresenceService,
  SessionsService,
} from '../contracts';
import { createControlModule } from '../modules/control';
import { createMessagingModule } from '../modules/messaging';
import { createPresenceModule } from '../modules/presence';
import { createSessionsModule } from '../modules/sessions';
import { SessionDispatcher } from '../modules/sessions/dispatcher';
import type { DeliveryPort } from '../ports';
import { FakeLeases, FakeTransport } from './fakes';
import { createTestHarness, type TestHarness } from './harness';

export interface ServiceHarness extends TestHarness {
  control: ControlService;
  messaging: MessagingService;
  presence: PresenceService;
  leases: FakeLeases;
  /** Flushes the outbox and returns what each agent received (with its class) since the last call. */
  drain(): Promise<Map<string, SessionDelivery[]>>;
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
  // Without sessions, the agents in `online` stand in for agents with an active session.
  const ready = new Set(options.online ?? []);
  presence.setReadyReader((id) => (ready.has(id) ? 'push' : null));
  for (const id of ready) presence.touch(id);
  let seen = 0;
  return {
    ...base,
    control,
    messaging,
    presence,
    leases: new FakeLeases(),
    async drain() {
      await base.outbox.flush();
      const fresh = base.ports.deliveries.slice(seen);
      seen = base.ports.deliveries.length;
      const byRecipient = new Map<string, SessionDelivery[]>();
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
    transport,
  }).service;
  h.presence.setReadyReader((id) => sessions.reach(id));
  dispatcher = new SessionDispatcher({
    sessions,
    messaging: h.messaging,
    transport,
    logger: h.ctx.logger,
  });
  return { ...h, sessions, transport, dispatcher };
}

/** The dispatch harness with helpers for alice-agent writing to bob-agent's sessions. */
export function createBobDispatchHarness() {
  const h = createDispatchHarness();
  /** A bob-agent session, activated at the clock's current time. */
  const active = () => {
    const id = h.sessions.open('bob-agent', { clientVersion: '0.2.0' }).session.id;
    h.sessions.activate('bob-agent', id, 'web client');
    return id;
  };
  const thread = () =>
    h.messaging.createThread({
      kind: 'conversation',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    }).id;
  let n = 0;
  /** Posts an ask; returns it as the outbox hands it over. */
  const ask = (threadId: number, refs: MessageRefs = {}): SessionDelivery => ({
    ...h.messaging.post({ threadId, senderId: 'alice-agent', kind: 'ask', body: `q${++n}`, refs })
      .message,
    class: 'action',
  });
  /** Posts a status notice for bob (the outbox hands it over as status). */
  const note = (threadId: number) =>
    h.messaging.post({
      threadId,
      senderId: 'alice-agent',
      kind: 'reply',
      body: `n${++n}`,
      deliveryClass: 'status',
    }).message;
  const pending = () =>
    h.ctx.db
      .all<{ message_id: string }>(
        "SELECT message_id FROM deliveries WHERE state = 'pending' ORDER BY rowid",
      )
      .map((r) => r.message_id);
  const liveness = (sessionId: string) => h.sessions.verify('bob-agent', sessionId).liveness;
  return { ...h, active, thread, ask, note, pending, liveness };
}
