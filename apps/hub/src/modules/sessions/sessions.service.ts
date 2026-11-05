import { MeshError, parseId, redactSecrets } from '@agentmesh/common';
import type {
  DeliveryMode,
  MeshMessage,
  RpcMethodName,
  SessionDelivery,
  SessionSummary,
  SessionView,
} from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type {
  CallContext,
  MessagingService,
  OpenInput,
  SessionRecord,
  SessionsService,
} from '../../contracts';
import { internalId, taskKey, threadKey } from '../../core/ids';
import { expireSessions, releaseAndClose } from './liveness';
import { toRecord, toSummary, toView } from './mappers';
import { openSession } from './open';
import { OrphanDecisions } from './orphans';
import { claimThread } from './ownership';
import { recordClaims } from './record-claims';
import { type RelayTarget, relayFor } from './relay';
import { releasedForRead, releasedMarker, routeInput } from './route-input';
import { chainOwner, type Route, routeDelivery } from './routing';
import { type SessionRow, SessionsRepo } from './sessions.repo';
import { type Adopted, adoptAwayWindows, logAdopted } from './takeover';

export interface SessionsDeps {
  messaging: MessagingService;
  /** Late-bound: the task and planning modules are built after this one. */
  locate(taskId: number): { threadId: number; repo: string | null } | null;
  threadOf(planId: number): number | null;
}

/**
 * Sessions and thread ownership (spec §3). Session ids from callers are
 * trusted only after `verify` matched them to the calling agent.
 */
export class SessionsServiceImpl implements SessionsService {
  readonly repo: SessionsRepo;
  readonly orphans: OrphanDecisions;
  readonly #ctx: HubContext;
  readonly #deps: SessionsDeps;

  constructor(ctx: HubContext, deps: SessionsDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.repo = new SessionsRepo(ctx.db);
    this.orphans = new OrphanDecisions(ctx, this.repo, deps.messaging);
  }

  /** Reuses an open previous session; after a closed one, reclaims what nobody took since. */
  open(agentId: string, input: OpenInput): { session: SessionRecord; reclaimed: number[] } {
    const { sessionId, reclaimed } = openSession(
      this.#ctx,
      this.repo,
      this.orphans,
      agentId,
      input,
    );
    return { session: this.verify(agentId, sessionId), reclaimed };
  }

  verify(agentId: string, sessionId: string): SessionRecord {
    return toRecord(this.#row(agentId, sessionId));
  }

  /**
   * Stamps `activated_at` only when the session was inactive, so re-activating keeps its age.
   * `delivery` replaces the previous mode. Kicks the outbox: messages waiting for an active
   * session can go now.
   */
  activate(
    agentId: string,
    sessionId: string,
    description: string,
    delivery: DeliveryMode = 'push',
  ): SessionRecord {
    let adopted: Adopted = { closed: [], reclaimed: [] };
    const record = this.#change(
      agentId,
      sessionId,
      `session activated (${delivery})`,
      (row, at) => {
        if (row.active === 0) this.repo.setActive(sessionId, true, at);
        this.repo.setDelivery(sessionId, delivery);
        this.repo.setDescription(sessionId, redactSecrets(description));
        adopted = adoptAwayWindows(this.repo, row, at);
      },
    );
    logAdopted(this.#ctx.logger, agentId, sessionId, adopted);
    this.#ctx.outbox.kick();
    return record;
  }

  /** A clean stop (spec §3): releases what the session owns at once; re-activating takes none of it back. */
  deactivate(agentId: string, sessionId: string): SessionRecord {
    const record = this.#change(agentId, sessionId, 'session deactivated', (_row, at) => {
      this.repo.setActive(sessionId, false, at);
      this.repo.releaseOwned(sessionId);
    });
    this.#ctx.outbox.kick();
    return record;
  }

  describe(agentId: string, sessionId: string, description: string): SessionRecord {
    return this.#change(agentId, sessionId, 'session described', () =>
      this.repo.setDescription(sessionId, redactSecrets(description)),
    );
  }

  close(agentId: string, sessionId: string): void {
    const released = this.#ctx.db.transaction(() => {
      this.#row(agentId, sessionId);
      return releaseAndClose(this.repo, sessionId, this.#now());
    });
    this.#ctx.logger.info(
      { agent: agentId, session: sessionId, released: released.length },
      'session closed',
    );
    this.#ctx.outbox.kick();
  }

  touch(agentId: string, sessionId: string, git: { repo?: string; branch?: string } = {}) {
    const row = this.repo.get(sessionId);
    if (!row || row.agent_id !== agentId || row.liveness === 'closed') return 'unknown';
    this.repo.touch(sessionId, this.#now(), git);
    // Back from away: what waited for it goes now, not on the next tick.
    if (this.repo.markLive(sessionId)) this.#ctx.outbox.kick();
    return 'ok';
  }

  unreachable(sessionId: string): void {
    this.repo.markAway(sessionId, this.#now());
  }

  route(agentId: string, message: MeshMessage): Route {
    // Lenient: a bad task ref must not wedge the agent's queue.
    const taskId = message.refs.taskId ? parseId('task', message.refs.taskId) : null;
    const threadId = internalId('thread', message.threadId);
    const input = routeInput(this.repo, this.#deps, agentId, threadId, taskId);
    return routeDelivery({
      ...input,
      picked: message.refs.session ?? null,
      repo: message.refs.repo ?? input.repo,
      released: releasedMarker(this.repo, agentId, threadId, input.threadOwner),
    });
  }

  relay(agentId: string, message: SessionDelivery): RelayTarget | null {
    return relayFor(this.repo, agentId, message);
  }

  effectiveOwner(threadId: number, agentId: string): string | null {
    const { taskId } = this.#deps.messaging.thread(threadId);
    const input = routeInput(this.repo, this.#deps, agentId, threadId, taskId);
    return chainOwner(input)?.session.id ?? null;
  }

  /**
   * Same precedence as an RPC claim: if another open session took the thread meanwhile, it keeps
   * it. A closed asker's answer claims nothing; it reached the window (`OrphanDecisions.reached`).
   */
  delivered(agentId: string, sessionId: string, message: MeshMessage, route: Route): void {
    if (route.kind !== 'deliver') return;
    const threadId = internalId('thread', message.threadId);
    if (route.released) this.orphans.reached(agentId, threadId, route.released, message);
    if (route.claim) claimThread(this.repo, { agentId, sessionId, threadId, at: this.#now() });
  }

  /** A window's read of a closed asker's thread: the push's marker; each `handed` item reached. */
  readReleased(agentId: string, sessionId: string, threadId: number, handed: MeshMessage[]) {
    return this.#ctx.db.transaction(() => {
      const released = releasedForRead(this.repo, this.#deps, agentId, sessionId, threadId);
      if (released) for (const m of handed) this.orphans.reached(agentId, threadId, released, m);
      return released;
    });
  }

  expire(now: Date) {
    return expireSessions(this.#ctx, this.repo, now);
  }

  /** Moves a thread the agent takes part in to this session (the owner and release lists at once). */
  take(agentId: string, sessionId: string, threadId: number): { previous: string | null } {
    const previous = this.#ctx.db.transaction(() => {
      this.#row(agentId, sessionId);
      const { messaging } = this.#deps;
      messaging.thread(threadId);
      if (!messaging.participants(threadId).includes(agentId)) {
        throw new MeshError('forbidden', `You are not a participant of ${threadKey(threadId)}`);
      }
      const owner = this.repo.owner(threadId, agentId);
      if (owner !== sessionId) this.repo.setOwner(threadId, agentId, sessionId, this.#now());
      return owner;
    });
    this.#ctx.logger.info(
      { agent: agentId, session: sessionId, thread: threadKey(threadId), previous },
      'thread taken',
    );
    this.#ctx.outbox.kick();
    return { previous };
  }

  /** Agent callers with a verified session only. Never moves work another open session owns. */
  recordClaims(call: CallContext, method: RpcMethodName, params: unknown, result: unknown): void {
    recordClaims(this.repo, this.#deps, this.#now(), call, method, params, result);
  }

  view(sessionId: string): SessionView {
    const row = this.repo.get(sessionId);
    if (!row) throw new MeshError('not_found', `Unknown session ${sessionId}`);
    return toView(row, this.repo.ownedThreads(row.id).map(threadKey));
  }

  /** Active, non-closed sessions with the tasks whose threads they own. */
  activeSessions(agentId: string): SessionSummary[] {
    const grace = this.#ctx.loaded.config.presence.ownershipGraceMinutes;
    return this.repo
      .listLive(agentId)
      .filter((s) => s.active === 1)
      .map((s) => toSummary(s, this.#ownedTasks(s.id), grace));
  }

  hasLiveSession(agentId: string): boolean {
    return this.repo.listLive(agentId).some((s) => s.liveness === 'live');
  }

  hasReadySession(agentId: string): boolean {
    return this.reach(agentId) === 'push';
  }

  reach(agentId: string): DeliveryMode | null {
    const ready = this.repo
      .listLive(agentId)
      .filter((s) => s.active === 1 && s.liveness === 'live');
    if (ready.some((s) => s.delivery === 'push')) return 'push';
    return ready.length > 0 ? 'pull' : null;
  }

  ownerOf(threadId: number, agentId: string): string | null {
    return this.repo.owner(threadId, agentId);
  }

  #row(agentId: string, sessionId: string): SessionRow {
    const row = this.repo.get(sessionId);
    if (!row || row.agent_id !== agentId || row.liveness === 'closed') {
      throw new MeshError('not_found', `Unknown or closed session ${sessionId}; reconnect`);
    }
    return row;
  }

  #change(
    agentId: string,
    sessionId: string,
    event: string,
    apply: (row: SessionRow, at: string) => void,
  ): SessionRecord {
    const record = this.#ctx.db.transaction(() => {
      apply(this.#row(agentId, sessionId), this.#now());
      return this.verify(agentId, sessionId);
    });
    this.#ctx.logger.info({ agent: agentId, session: sessionId }, event);
    return record;
  }

  #ownedTasks(sessionId: string): string[] {
    return this.repo.ownedThreads(sessionId).flatMap((threadId) => {
      const taskId = this.#deps.messaging.thread(threadId).taskId;
      return taskId === null ? [] : [taskKey(taskId)];
    });
  }

  #now(): string {
    return this.#ctx.clock.now().toISOString();
  }
}
