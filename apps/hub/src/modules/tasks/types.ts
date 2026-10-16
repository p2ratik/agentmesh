import type { LeaseService, MessagingService, PresenceService } from '../../contracts';

/** Services the task module consumes (through contracts only). */
export interface TaskModuleDeps {
  messaging: MessagingService;
  presence: PresenceService;
  leases: LeaseService;
}

/** A next step rendered for an agent: the action and the fields it still has to pass. */
export interface NextAction {
  action: string;
  missing: readonly string[];
}
