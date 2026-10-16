import type { LoadedConfig } from '@agentmesh/config';
import type { MeshMessage } from '@agentmesh/protocol';
import type { MessagingService, PresenceService } from '../contracts';
import { createControlModule } from '../modules/control';
import { createMessagingModule } from '../modules/messaging';
import { createPresenceModule } from '../modules/presence';
import { FakeLeases } from './fakes';
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
  options: { online?: string[] } = {},
): ServiceHarness {
  const base = createTestHarness(loaded);
  const control = createControlModule(base.ctx, {
    peers: () => [],
    counts: () => ({ openThreads: 0, openTasks: 0, activePlans: 0 }),
  }).service;
  let messaging: MessagingService | null = null;
  const presence = createPresenceModule(base.ctx, {
    unreadThreadCount: (id) => messaging?.unreadThreadCount(id) ?? 0,
  }).service;
  messaging = createMessagingModule(base.ctx, { control, presence }).service;
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
