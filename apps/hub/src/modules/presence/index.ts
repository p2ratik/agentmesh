import type { HubContext } from '../../context';
import type { HubModule, PresenceService } from '../../contracts';
import { presenceHandlers } from './handlers';
import { PresenceServiceImpl } from './presence.service';

export { parseHeartbeat, type Subscription, startPresenceListener } from './listener';

/** Participants synced from config, live presence, and the offline-expiry tick. */
export function createPresenceModule(ctx: HubContext): HubModule<PresenceService> {
  const service = new PresenceServiceImpl(ctx);
  service.syncFromConfig();
  return {
    service,
    handlers: presenceHandlers(service),
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
