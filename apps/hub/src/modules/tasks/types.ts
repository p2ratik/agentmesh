import type { LeaseService, MessagingService, PresenceService } from '../../contracts';

/** Services the task module consumes (through contracts only). */
export interface TaskModuleDeps {
  messaging: MessagingService;
  presence: PresenceService;
  leases: LeaseService;
  /** Whether this session of the agent receives its team work; absent: every session does. */
  isActiveSessionOf?: (agentId: string, sessionId: string) => boolean;
}

/** A next step rendered for an agent: the action and the fields it still has to pass. */
export interface NextAction {
  action: string;
  missing: readonly string[];
}
