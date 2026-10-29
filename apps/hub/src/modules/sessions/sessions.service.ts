import { MeshError, newSessionId, parseId, redactSecrets } from '@agentmesh/common';
import type { MeshMessage, RpcMethodName, SessionSummary, SessionView } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type {
  CallContext,
  MessagingService,
  SessionRecord,
  SessionsService,
} from '../../contracts';
import { internalId, taskKey, threadKey } from '../../core/ids';
import { claimTargets } from './claims';
import { evictStalest, expireSessions, releaseAndClose } from './liveness';
import { claimedThread, claimThread, reclaimReleased } from './ownership';
import { chainOwner, type Route, type RouteInput, routeDelivery } from './routing';
import { type SessionRow, SessionsRepo } from './sessions.repo';

export interface SessionsDeps {
  messaging: MessagingService;
  /** Late-bound: the task and planning modules are built after this one. */
  locate(taskId: number): { threadId: number; repo: string | null } | null;
  threadOf(planId: number): number | null;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    active: row.active === 1,
    liveness: row.liveness,
    description: row.description,
    repo: row.repo,
    branch: row.branch,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    lastSeen: row.last_seen,
  };
}

/**
 * Sessions and thread ownership (spec §3). Session ids from callers are
 * trusted only after `verify` matched them to the calling agent.
 */
export class SessionsServiceImpl implements SessionsService {
  readonly repo: SessionsRepo;
  readonly #ctx: HubContext;
  readonly #deps: SessionsDeps;

  constructor(ctx: HubContext, deps: SessionsDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.repo = new SessionsRepo(ctx.db);
  }

  /** Reuses an open previous session; after a closed one, reclaims what nobody took since. */
  open(
    agentId: string,
    input: { clientVersion: string; repo?: string; branch?: string; previousSessionId?: string },
  ): { session: SessionRecord; reclaimed: number[] } {
    const at = this.#now();
    const git = { repo: input.repo ?? null, branch: input.branch ?? null };
    const result = this.#ctx.db.transaction(() => {
      const previous = input.previousSessionId ? this.repo.get(input.previousSessionId) : undefined;
      const mine = previous?.agent_id === agentId ? previous : undefined;
      if (mine && mine.liveness !== 'closed') {
        this.repo.touch(mine.id, at, git);
        if (this.repo.markLive(mine.id)) this.#ctx.outbox.kick();
        return { session: this.verify(agentId, mine.id), reclaimed: [] };
      }
      const id = newSessionId();
      const evicted = evictStalest(this.#ctx, this.repo, agentId, at);
      this.repo.insert({ id, agentId, clientVersion: input.clientVersion, ...git, at });
      const reclaimed = mine ? reclaimReleased(this.repo, mine, id, at) : [];
      return { session: this.verify(agentId, id), reclaimed, evicted };
    });
    const { session, reclaimed, evicted = 0 } = result;
    this.#ctx.logger.info(
      { agent: agentId, session: session.id, reclaimed: reclaimed.length, evicted },
      'session opened',
    );
    // What the closed sessions owned goes elsewhere now.
    if (evicted) this.#ctx.outbox.kick();
    return result;
  }

  verify(agentId: string, sessionId: string): SessionRecord {
    return toRecord(this.#row(agentId, sessionId));
  }

  /**
   * Stamps `activated_at` only when the session was inactive, so re-activating keeps its age.
   * Kicks the outbox: messages waiting for an active session can go now.
   */
  activate(agentId: string, sessionId: string, description: string): SessionRecord {
    const record = this.#change(agentId, sessionId, 'session activated', (row, at) => {
      if (row.active === 0) this.repo.setActive(sessionId, true, at);
      this.repo.setDescription(sessionId, redactSecrets(description));
    });
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
    const input = this.#routeInput(agentId, internalId('thread', message.threadId), taskId);
    return routeDelivery({
      ...input,
      picked: message.refs.session ?? null,
      repo: message.refs.repo ?? input.repo,
    });
  }

  effectiveOwner(threadId: number, agentId: string): string | null {
    const { taskId } = this.#deps.messaging.thread(threadId);
    return chainOwner(this.#routeInput(agentId, threadId, taskId))?.session.id ?? null;
  }

  /** Same precedence as an RPC claim: if another open session took the thread meanwhile, it keeps it. */
  delivered(agentId: string, sessionId: string, message: MeshMessage, route: Route): void {
    if (route.kind !== 'deliver' || !route.claim) return;
    const threadId = internalId('thread', message.threadId);
    claimThread(this.repo, { agentId, sessionId, threadId, at: this.#now() });
  }

  expire(now: Date) {
    return expireSessions(this.#ctx, this.repo, now);
  }

  /** Moves a thread the agent takes part in to this session. */
  take(agentId: string, sessionId: string, threadId: number): { previous: string | null } {
    this.#row(agentId, sessionId);
    const { messaging } = this.#deps;
    messaging.thread(threadId);
    if (!messaging.participants(threadId).includes(agentId)) {
      throw new MeshError('forbidden', `You are not a participant of ${threadKey(threadId)}`);
    }
    const previous = this.repo.owner(threadId, agentId);
    if (previous !== sessionId) this.repo.setOwner(threadId, agentId, sessionId, this.#now());
    this.#ctx.logger.info(
      { agent: agentId, session: sessionId, thread: threadKey(threadId), previous },
      'thread taken',
    );
    this.#ctx.outbox.kick();
    return { previous };
  }

  /** Agent callers with a verified session only. Never moves work another open session owns. */
  recordClaims(call: CallContext, method: RpcMethodName, params: unknown, result: unknown): void {
    const { session: sessionId } = call;
    if (call.caller.kind !== 'agent' || !sessionId) return;
    for (const target of claimTargets(method, params, result)) {
      const threadId = claimedThread(target, this.#deps);
      if (threadId === null) continue;
      const claim = { agentId: call.caller.id, sessionId, threadId, at: this.#now() };
      const note = claimThread(this.repo, claim);
      if (note) call.notes.push(note);
    }
  }

  view(sessionId: string): SessionView {
    const row = this.repo.get(sessionId);
    if (!row) throw new MeshError('not_found', `Unknown session ${sessionId}`);
    return {
      id: row.id,
      active: row.active === 1,
      description: row.description,
      repo: row.repo,
      branch: row.branch,
      owns: this.repo.ownedThreads(row.id).map(threadKey),
    };
  }

  /** Active, non-closed sessions with the tasks whose threads they own. */
  activeSessions(agentId: string): SessionSummary[] {
    return this.repo
      .listLive(agentId)
      .filter((s) => s.active === 1)
      .map((s) => ({
        id: s.id,
        description: s.description ?? '',
        repo: s.repo,
        branch: s.branch,
        activeSince: s.activated_at ?? s.created_at,
        tasks: this.#ownedTasks(s.id),
      }));
  }

  hasLiveSession(agentId: string): boolean {
    return this.repo.listLive(agentId).some((s) => s.liveness === 'live');
  }

  hasReadySession(agentId: string): boolean {
    return this.repo.listLive(agentId).some((s) => s.active === 1 && s.liveness === 'live');
  }

  ownerOf(threadId: number, agentId: string): string | null {
    return this.repo.owner(threadId, agentId);
  }

  /** Routing's view of a thread: the agent's open sessions and the owner chain; no sender pick. */
  #routeInput(agentId: string, threadId: number, taskId: number | null): RouteInput {
    const owner = (id: number | null) => (id === null ? null : this.repo.owner(id, agentId));
    const task = taskId === null ? null : this.#deps.locate(taskId);
    return {
      sessions: this.repo.listLive(agentId).map((s) => ({
        id: s.id,
        active: s.active === 1,
        liveness: s.liveness === 'live' ? 'live' : 'away',
        repo: s.repo,
        activatedAt: s.activated_at,
      })),
      threadOwner: owner(threadId),
      parentOwner: owner(this.#deps.messaging.thread(threadId).parentId),
      taskOwner: task && task.threadId !== threadId ? owner(task.threadId) : null,
      picked: null,
      repo: task?.repo ?? null,
    };
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
