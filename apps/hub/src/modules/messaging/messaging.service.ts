import { MeshError } from '@agentmesh/common';
import type {
  DeliveryClass,
  MeshMessage,
  ParticipantRef,
  SessionDelivery,
  ThreadSummary,
} from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type {
  ControlService,
  CreateThreadInput,
  MessagingService,
  PostInput,
  PostResult,
  PresenceService,
  ThreadOwner,
  ThreadRecord,
} from '../../contracts';
import { internalId, threadKey } from '../../core/ids';
import { hubDisplayName } from '../presence/peer';
import { toMeshMessage, toThreadSummary } from './mappers';
import { type MessageRow, MessagesRepo } from './messages.repo';
import { type PostContext, postMessage } from './post';
import { ReadsRepo } from './reads.repo';
import { ThreadsRepo } from './threads.repo';

export interface MessagingDeps {
  control: ControlService;
  presence: PresenceService;
  /** Late-bound to the sessions module (built after messaging): may a sender pick this session? */
  isActiveSessionOf(agentId: string, sessionId: string): boolean;
}

const MAX_SUBJECT = 120;

/** Threads, messages and read state. The single writer of messaging tables. */
export class MessagingServiceImpl implements MessagingService {
  readonly hubId: string;
  readonly ctx: HubContext;
  readonly deps: MessagingDeps;
  readonly threads: ThreadsRepo;
  readonly messages: MessagesRepo;
  readonly reads: ReadsRepo;
  readonly #post: PostContext;
  #ownerOf: (threadId: number, agentId: string) => ThreadOwner | null = () => null;

  constructor(ctx: HubContext, deps: MessagingDeps) {
    this.ctx = ctx;
    this.deps = deps;
    this.hubId = ctx.loaded.config.hub.serviceId;
    this.threads = new ThreadsRepo(ctx.db);
    this.messages = new MessagesRepo(ctx.db);
    this.reads = new ReadsRepo(ctx.db);
    this.#post = {
      ctx,
      control: deps.control,
      hubId: this.hubId,
      threads: this.threads,
      messages: this.messages,
      reads: this.reads,
      thread: (id) => this.thread(id),
      summary: (id) => this.summary(id),
      refOf: (id) => this.refOf(id),
      assertKnown: (ids) => this.assertKnown(ids),
    };
  }

  /**
   * Depth is the parent's + 1; past `limits.maxThreadDepth` it is a loop. The hub never joins.
   * Callers redact the subject where its text comes in, before any cut (a cut token no longer
   * matches), so this only cuts it.
   */
  createThread(input: CreateThreadInput): ThreadRecord {
    const { db, clock, outbox, loaded } = this.ctx;
    const parent = input.parentThreadId ? this.thread(input.parentThreadId) : null;
    const depth = parent ? parent.depth + 1 : 0;
    const max = loaded.config.limits.maxThreadDepth;
    if (depth > max) {
      throw new MeshError('loop_detected', `Thread chain is deeper than ${max}`, { depth, max });
    }
    const members = [...new Set([input.createdBy, ...input.participants])].filter(
      (id) => id !== this.hubId,
    );
    this.assertKnown(members);
    const at = clock.now().toISOString();
    const id = db.transaction(() => {
      const threadId = this.threads.insert({
        kind: input.kind,
        subject: input.subject.trim().slice(0, MAX_SUBJECT) || input.kind,
        createdBy: input.createdBy,
        depth,
        parentId: parent?.id ?? null,
        taskId: input.taskId ?? null,
        planId: input.planId ?? null,
        at,
      });
      this.threads.addParticipants(threadId, members, at);
      outbox.enqueueEvent('thread.created', { thread: this.summary(threadId) });
      return threadId;
    });
    outbox.kick();
    return this.thread(id);
  }

  post(input: PostInput): PostResult {
    return postMessage(this.#post, input);
  }

  addParticipants(threadId: number, participantIds: string[]): void {
    this.thread(threadId);
    const ids = participantIds.filter((id) => id !== this.hubId);
    this.assertKnown(ids);
    this.threads.addParticipants(threadId, ids, this.ctx.clock.now().toISOString());
  }

  participants(threadId: number): string[] {
    return this.threads.participants(threadId);
  }

  isParticipant(threadId: number, participantId: string): boolean {
    return this.threads.isParticipant(threadId, participantId);
  }

  /** Idempotent: closing a closed thread returns it unchanged. */
  closeThread(threadId: number, by: string): ThreadSummary {
    if (this.thread(threadId).status === 'open') {
      this.threads.close(threadId, this.ctx.clock.now().toISOString());
      this.ctx.logger.info({ thread: threadKey(threadId), by }, 'thread closed');
    }
    return this.summary(threadId);
  }

  thread(threadId: number): ThreadRecord {
    const thread = this.threads.get(threadId);
    if (!thread) throw new MeshError('not_found', `Thread ${threadKey(threadId)} not found`);
    return thread;
  }

  summary(threadId: number): ThreadSummary {
    return toThreadSummary(this.thread(threadId), this.threads.participants(threadId));
  }

  /** Summaries for many threads with one participants query. */
  summaries(threads: readonly ThreadRecord[]): ThreadSummary[] {
    const members = this.threads.participantsOf(threads.map((t) => t.id));
    return threads.map((t) => toThreadSummary(t, members.get(t.id) ?? []));
  }

  linkThread(threadId: number, link: { taskId?: number; planId?: number }): void {
    this.thread(threadId);
    this.threads.link(threadId, link.taskId ?? null, link.planId ?? null);
  }

  unreadThreadCount(participantId: string): number {
    return this.reads.unreadThreadCount(participantId);
  }

  markRead(participantId: string, messageIds: string[]): void {
    for (const id of messageIds) {
      const at = this.messages.position(id);
      if (at) this.reads.advance(at.threadId, participantId, at.seq);
    }
  }

  /** The plugin reports these ids, so only messages addressed to the agent move its cursors. */
  markSeen(agentId: string, messageIds: string[]): void {
    for (const { threadId, seq } of this.messages.latestAddressedTo(agentId, messageIds)) {
      this.reads.advance(threadId, agentId, seq);
    }
  }

  /**
   * The agent's unread status items in a thread (`key` is its protocol id), newest
   * `limit`, oldest first. The dispatcher carries them along with every delivery in
   * that thread, so a cursor that passes them never hides one no session was shown.
   */
  unreadStatusIn(agentId: string, key: string, limit: number): SessionDelivery[] {
    return this.reads
      .unreadStatus(internalId('thread', key), agentId, limit)
      .map((row) => ({ ...this.toMessage(row), class: 'status' }));
  }

  isRead(participantId: string, messageId: string): boolean {
    const at = this.messages.position(messageId);
    const cursor = at ? this.reads.cursor(at.threadId, participantId) : null;
    return at !== undefined && cursor !== null && at.seq <= cursor;
  }

  /** `status` when the message was stored as status for this participant; `action` otherwise. */
  classFor(messageId: string, participantId: string): DeliveryClass {
    return this.messages.statusFor(messageId).includes(participantId) ? 'status' : 'action';
  }

  setOwnerReader(reader: (threadId: number, agentId: string) => ThreadOwner | null): void {
    this.#ownerOf = reader;
  }

  /** The session that owns the agent's side of a thread; null when nobody does. */
  ownerOf(threadId: number, agentId: string): ThreadOwner | null {
    return this.#ownerOf(threadId, agentId);
  }

  openThreadCount(): number {
    return this.threads.openCount();
  }

  toMessage(row: MessageRow): MeshMessage {
    return toMeshMessage(row, this.refOf(row.sender_id));
  }

  /** Lenient for history: senders removed from config still render. */
  refOf(participantId: string): ParticipantRef {
    if (participantId === this.hubId) {
      return {
        id: participantId,
        kind: 'service',
        displayName: hubDisplayName(this.ctx.loaded.config),
      };
    }
    return (
      this.ctx.index.ref(participantId) ?? {
        id: participantId,
        kind: 'service',
        displayName: participantId,
      }
    );
  }

  assertKnown(participantIds: readonly string[]): void {
    const unknown = participantIds.filter((id) => this.ctx.index.kindOf(id) === undefined);
    if (unknown.length > 0) {
      throw new MeshError('invalid_request', `Unknown participants: ${unknown.join(', ')}`, {
        unknown,
      });
    }
  }
}
