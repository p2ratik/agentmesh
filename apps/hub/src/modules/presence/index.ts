import type { HubContext } from '../../context';
import type { HubModule, PresenceService } from '../../contracts';
import { type PresenceDeps, presenceHandlers } from './handlers';
import { PresenceServiceImpl } from './presence.service';

export type { PresenceDeps } from './handlers';
export { parseHeartbeat, type Subscription, startPresenceListener } from './listener';

/** Participants synced from config, live presence, and the offline-expiry tick. */
export function createPresenceModule(
  ctx: HubContext,
  deps: PresenceDeps,
): HubModule<PresenceService> {
  const service = new PresenceServiceImpl(ctx);
  service.syncFromConfig();
  return {
    service,
    handlers: presenceHandlers(ctx, service, deps),
    ticks: [
      {
        name: 'presence.expire',
        run: (now) => {
          service.expireStale(now);
        },
      },
    ],
  };
}
