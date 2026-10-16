import type { HubContext } from '../../context';
import type { ControlService } from '../../contracts';
import { readPauseState, writePauseState } from './pause-state';
import { RefsRepo } from './refs.repo';

/** Kill switch (pause/resume) and external-id refs for bridges. */
export class ControlServiceImpl implements ControlService {
  readonly #ctx: HubContext;
  readonly #refs: RefsRepo;

  constructor(ctx: HubContext) {
    this.#ctx = ctx;
    this.#refs = new RefsRepo(ctx.db);
  }

  isPaused(): boolean {
    return readPauseState(this.#ctx.db)?.paused ?? false;
  }

  pausedReason(): string | null {
    const state = readPauseState(this.#ctx.db);
    return state?.paused ? state.reason : null;
  }

  /** Pausing again only updates the reason; the event fires on the transition. */
  pause(by: string, reason: string | null): void {
    const { db, outbox, clock } = this.#ctx;
    db.transaction(() => {
      const wasPaused = this.isPaused();
      writePauseState(db, { paused: true, reason, by, at: clock.now().toISOString() });
      if (!wasPaused) outbox.enqueueEvent('mesh.paused', { by, reason });
    });
    outbox.kick();
  }

  resume(by: string): number {
    const { db, outbox, clock } = this.#ctx;
    const released = db.transaction(() => {
      const wasPaused = this.isPaused();
      writePauseState(db, { paused: false, reason: null, by, at: clock.now().toISOString() });
      const count = outbox.releaseHeld();
      if (wasPaused || count > 0) outbox.enqueueEvent('mesh.resumed', { by, released: count });
      return count;
    });
    outbox.kick();
    return released;
  }

  setRef(system: string, entityType: string, entityId: string, ref: string): void {
    this.#refs.set(system, entityType, entityId, ref);
  }

  getRef(system: string, entityType: string, entityId: string): string | null {
    return this.#refs.get(system, entityType, entityId);
  }

  findRef(system: string, ref: string): { entityType: string; entityId: string } | null {
    return this.#refs.find(system, ref);
  }
}
