import type { HubContext } from '../../context';
import type { HubModule, PresenceService, SessionsService } from '../../contracts';
import { sessionHandlers } from './handlers';
import { type SessionsDeps, SessionsServiceImpl } from './sessions.service';

export type { SessionsDeps } from './sessions.service';

export interface SessionsModuleDeps extends SessionsDeps {
  presence: PresenceService;
}

/** Claude Code sessions, thread ownership, and the session RPCs (hello, bye, activate, take). */
export function createSessionsModule(
  ctx: HubContext,
  deps: SessionsModuleDeps,
): HubModule<SessionsService> {
  const service = new SessionsServiceImpl(ctx, deps);
  return {
    service,
    handlers: sessionHandlers(ctx, service, deps),
    ticks: [{ name: 'sessions.expire', run: (now) => void service.expire(now) }],
  };
}
