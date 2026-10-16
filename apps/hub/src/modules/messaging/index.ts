import type { HubContext } from '../../context';
import type { HubModule, MessagingService } from '../../contracts';
import { type MessagingDeps, MessagingServiceImpl } from './messaging.service';
import { sendHandlers } from './send.handlers';
import { threadHandlers } from './thread.handlers';

export type { MessagingDeps } from './messaging.service';
export { redactSecrets } from './redact';

/** The messaging module, plus the open-thread count `mesh.status` reports. */
export interface MessagingModule extends HubModule<MessagingService> {
  openThreadCount(): number;
}

/** Threads, messages, deliveries, limits, redaction and read state. */
export function createMessagingModule(ctx: HubContext, deps: MessagingDeps): MessagingModule {
  const service = new MessagingServiceImpl(ctx, deps);
  return {
    service,
    handlers: { ...sendHandlers(service), ...threadHandlers(service) },
    openThreadCount: () => service.openThreadCount(),
  };
}
