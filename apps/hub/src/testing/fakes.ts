import { newMessageId } from '@agentmesh/common';
import type { ConfigIndex } from '@agentmesh/config';
import type { MeshMessage, PeerInfo, PresenceStatus, ThreadSummary } from '@agentmesh/protocol';
import type {
  CreateThreadInput,
  LeaseService,
  MessagingService,
  PostInput,
  PostResult,
  PresenceService,
  ThreadRecord,
} from '../contracts';
import { optionalKey, threadKey } from '../core/ids';
import type { SessionTransport } from '../modules/sessions/dispatcher';

/**
 * In-memory MessagingService honoring the contract (recipient defaults,
 * explicit `[]`, `addToThread`). For unit tests of modules that post messages.
 */
export class FakeMessaging implements MessagingService {
  readonly hubId = 'hub';
  readonly threads = new Map<number, ThreadRecord & { participants: Set<string> }>();
  readonly posts: Array<PostInput & { message: MeshMessage; recipients: string[] }> = [];
  #nextThread = 1;

  createThread(input: CreateThreadInput): ThreadRecord {
    const now = '2026-10-16T09:00:00.000Z';
    const record = {
      id: this.#nextThread++,
      kind: input.kind,
      subject: input.subject,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      depth: 0,
      parentId: input.parentThreadId ?? null,
      taskId: input.taskId ?? null,
      planId: input.planId ?? null,
      status: 'open' as const,
      messageCount: 0,
      participants: new Set(input.participants),
    };
    this.threads.set(record.id, record);
    return record;
  }

  post(input: PostInput): PostResult {
    const thread = this.#get(input.threadId);
    const recipients = input.to ?? [...thread.participants].filter((p) => p !== input.senderId);
    if (input.to && input.addToThread !== false)
      for (const id of input.to) thread.participants.add(id);
    thread.messageCount += 1;
    const message: MeshMessage = {
      id: newMessageId(),
      threadId: threadKey(thread.id),
      kind: input.kind,
      from: {
        id: input.senderId,
        kind: input.senderId === this.hubId ? 'service' : 'agent',
        displayName: input.senderId,
      },
      to: recipients,
      subject: thread.subject,
      body: input.body,
      status: input.status ?? null,
      trust: input.trust ?? 'team',
      depth: thread.depth,
      refs: input.refs ?? {},
      createdAt: '2026-10-16T09:00:00.000Z',
    };
    this.posts.push({ ...input, message, recipients });
    return { message, deliveredTo: recipients, held: false };
  }

  addParticipants(threadId: number, participantIds: string[]): void {
    for (const id of participantIds) this.#get(threadId).participants.add(id);
  }

  participants(threadId: number): string[] {
    return [...this.#get(threadId).participants];
  }

  closeThread(threadId: number): ThreadSummary {
    this.#get(threadId).status = 'closed';
    return this.summary(threadId);
  }

  thread(threadId: number): ThreadRecord {
    return this.#get(threadId);
  }

  summary(threadId: number): ThreadSummary {
    const t = this.#get(threadId);
    return {
      id: threadKey(t.id),
      kind: t.kind,
      subject: t.subject,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      depth: t.depth,
      parentId: optionalKey('thread', t.parentId),
      participants: [...t.participants],
      taskId: optionalKey('task', t.taskId),
      planId: optionalKey('plan', t.planId),
      status: t.status,
      messageCount: t.messageCount,
    };
  }

  linkThread(threadId: number, link: { taskId?: number; planId?: number }): void {
    const t = this.#get(threadId);
    if (link.taskId !== undefined) t.taskId = link.taskId;
    if (link.planId !== undefined) t.planId = link.planId;
  }

  unreadThreadCount(): number {
    return 0;
  }

  markRead(): void {}

  isRead(): boolean {
    return false;
  }

  setOwnerReader(): void {}

  /** Messages delivered to one participant, in order. */
  deliveredTo(participantId: string): MeshMessage[] {
    return this.posts.filter((p) => p.recipients.includes(participantId)).map((p) => p.message);
  }

  #get(threadId: number) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error(`thread ${threadId} not found`);
    return t;
  }
}

/** PresenceService where tests choose who is online. */
export class FakePresence implements PresenceService {
  readonly online = new Set<string>();
  readonly assigned = new Map<string, string>();
  #load: () => Map<string, number> = () => new Map();
  readonly #index: ConfigIndex;

  constructor(index: ConfigIndex, online: string[] = []) {
    this.#index = index;
    for (const id of online) this.online.add(id);
  }

  syncFromConfig(): void {}
  touch(id: string): void {
    this.online.add(id);
  }
  setDeclared(): void {}
  markOffline(id: string): void {
    this.online.delete(id);
  }
  isOnline(id: string): boolean {
    return this.online.has(id);
  }
  status(id: string): PresenceStatus {
    return this.online.has(id) ? 'online' : 'offline';
  }
  peer(id: string): PeerInfo {
    const agent = this.#index.agent(id);
    return {
      id,
      kind: this.#index.kindOf(id) ?? 'agent',
      displayName: this.#index.displayName(id),
      owner: agent?.owner ?? null,
      status: this.status(id),
      statusNote: null,
      lastSeen: null,
      repo: null,
      branch: null,
      skills: agent?.skills ?? [],
      areas: this.#index.areasOwnedBy(id).map((a) => a.id),
      activeTasks: this.#load().get(id) ?? 0,
      sessions: [],
    };
  }
  peers(): PeerInfo[] {
    return this.#index.agents().map((a) => this.peer(a.id));
  }
  lastAssignedAt(id: string): string | null {
    return this.assigned.get(id) ?? null;
  }
  markAssigned(id: string, at: Date): void {
    this.assigned.set(id, at.toISOString());
  }
  setLoadReader(reader: () => Map<string, number>): void {
    this.#load = reader;
  }
  setSessionReader(): void {}
}

/** Records every send and check. A session acks all it gets unless `respond` says otherwise. */
export class FakeTransport implements SessionTransport {
  readonly sends: Array<{ agentId: string; sessionId: string; ids: string[] }> = [];
  readonly checks: Array<{ agentId: string; sessionId: string; code: string }> = [];
  /** Per session: ack a subset, reject, or hand back a promise the test settles. */
  readonly respond = new Map<string, (messages: MeshMessage[]) => Promise<string[]>>();
  /** Set to make every check fail, as when nobody listens on the session subject. */
  checkError: Error | null = null;

  async check(agentId: string, sessionId: string, code: string): Promise<void> {
    this.checks.push({ agentId, sessionId, code });
    if (this.checkError) throw this.checkError;
  }

  send(agentId: string, sessionId: string, messages: MeshMessage[]): Promise<string[]> {
    this.sends.push({ agentId, sessionId, ids: messages.map((m) => m.id) });
    const respond = this.respond.get(sessionId);
    return respond ? respond(messages) : Promise.resolve(messages.map((m) => m.id));
  }

  expired(): void {}
}

export class FakeLeases implements LeaseService {
  readonly releasedTasks: number[] = [];
  releaseForTask(taskId: number): number {
    this.releasedTasks.push(taskId);
    return 0;
  }
  releaseAll(): number {
    return 0;
  }
}
