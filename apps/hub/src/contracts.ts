/**
 * Contracts between hub modules. Modules depend on these interfaces, never on
 * each other's internals or tables. Internal ids are integers; protocol ids
 * (`thr-12`, `task-42`, `plan-7`) are produced only at the edges.
 */
import type {
  DeliveryClass,
  IngestEvent,
  MemberRecord,
  MeshMessage,
  MessageKind,
  MessageRefs,
  ParticipantKind,
  PeerInfo,
  Plan,
  PresenceStatus,
  ReplyStatus,
  RpcMethodName,
  RpcParams,
  RpcResult,
  SessionDelivery,
  SessionSummary,
  TaskDetail,
  ThreadKind,
  ThreadSummary,
  Trust,
} from '@agentmesh/protocol';
import type { ThreadOwner } from './sessions.contracts';

/** The sessions module's and the outbox's contracts have their own files, to keep this one small. */
export type { Outbox } from './outbox.contracts';
export type { SessionRecord, SessionsService, ThreadOwner } from './sessions.contracts';

/** Who is acting. For bridge calls with `actAs`, this is the human, not the bridge. */
export interface Actor {
  id: string;
  kind: ParticipantKind;
  roles: string[];
  /** Set when a trusted service relays on behalf of a human. */
  viaService?: string;
}

// ---------------------------------------------------------------- RPC

export interface CallContext {
  actor: Actor;
  /** The authenticated NATS identity (the bridge, for relayed human calls). */
  caller: Actor;
  method: RpcMethodName;
  /** The calling agent's session, verified by the router; null otherwise. */
  session: string | null;
  /** Advisory notes returned with the result (handlers and claims append). */
  notes: string[];
}

export type RpcHandler<M extends RpcMethodName> = (
  params: RpcParams<M>,
  call: CallContext,
) => RpcResult<M> | Promise<RpcResult<M>>;

export type RpcHandlerMap = { [M in RpcMethodName]: RpcHandler<M> };

// ---------------------------------------------------------------- lifecycle

export interface TickJob {
  name: string;
  run(now: Date): void | Promise<void>;
}

/** What every module factory returns. `app.ts` wires them together. */
export interface HubModule<S> {
  service: S;
  handlers: Partial<RpcHandlerMap>;
  ticks?: TickJob[];
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

// ---------------------------------------------------------------- control

export interface ControlService {
  isPaused(): boolean;
  pausedReason(): string | null;
  pause(by: string, reason: string | null): void;
  /** Returns how many held deliveries were released. */
  resume(by: string): number;
  setRef(system: string, entityType: string, entityId: string, ref: string): void;
  getRef(system: string, entityType: string, entityId: string): string | null;
  findRef(system: string, ref: string): { entityType: string; entityId: string } | null;
}

// ---------------------------------------------------------------- presence

export interface PresenceService {
  /** Re-reads participants from `ctx.index` (after members join or leave). */
  syncFromConfig(): void;
  /** Mark online and refresh last-seen (heartbeats and every RPC call). */
  touch(participantId: string, info?: { repo?: string; branch?: string }): void;
  setDeclared(participantId: string, status: 'online' | 'busy' | 'away', note: string | null): void;
  markOffline(participantId: string): void;
  isOnline(participantId: string): boolean;
  status(participantId: string): PresenceStatus;
  peer(participantId: string): PeerInfo;
  peers(kind?: ParticipantKind | 'all'): PeerInfo[];
  lastAssignedAt(participantId: string): string | null;
  markAssigned(participantId: string, at: Date): void;
  /** Wired by app.ts once the task module exists (avoids a module cycle). */
  setLoadReader(reader: () => Map<string, number>): void;
  /** Wired once the sessions module exists: an agent's active sessions for `PeerInfo`. */
  setSessionReader(reader: (agentId: string) => SessionSummary[]): void;
}

// ---------------------------------------------------------------- messaging

export interface ThreadRecord {
  id: number;
  kind: ThreadKind;
  subject: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  depth: number;
  parentId: number | null;
  taskId: number | null;
  planId: number | null;
  status: 'open' | 'closed';
  messageCount: number;
}

export interface CreateThreadInput {
  kind: ThreadKind;
  subject: string;
  createdBy: string;
  participants: string[];
  parentThreadId?: number | null;
  taskId?: number | null;
  planId?: number | null;
}

export interface PostInput {
  threadId: number;
  /** Participant id, or the hub's own service id for system notices. */
  senderId: string;
  kind: MessageKind;
  body: string;
  status?: ReplyStatus | null;
  trust?: Trust;
  refs?: MessageRefs;
  /**
   * Recipients. Omitted: every thread participant except the sender.
   * An explicit empty array stores the message (history, feed) but delivers to nobody.
   */
  to?: string[];
  /** Whether explicit recipients join the thread (default true). Board announcements pass false. */
  addToThread?: boolean;
  /** Hub-generated messages skip rate limits and dedup. */
  system?: boolean;
  /** One class for every recipient, or a function picking each one's; default `action`. */
  deliveryClass?: DeliveryClass | ((recipientId: string) => DeliveryClass);
}

export interface PostResult {
  message: MeshMessage;
  deliveredTo: string[];
  held: boolean;
}

export interface MessagingService {
  /** The hub's own sender id for system messages. */
  readonly hubId: string;
  createThread(input: CreateThreadInput): ThreadRecord;
  /** Stores, redacts, enforces limits, enqueues deliveries and the feed event. Sync (DB only). */
  post(input: PostInput): PostResult;
  addParticipants(threadId: number, participantIds: string[]): void;
  participants(threadId: number): string[];
  closeThread(threadId: number, by: string): ThreadSummary;
  thread(threadId: number): ThreadRecord;
  summary(threadId: number): ThreadSummary;
  linkThread(threadId: number, link: { taskId?: number; planId?: number }): void;
  /** Threads with unread messages for this participant. */
  unreadThreadCount(participantId: string): number;
  /** Advances the participant's read cursor past each message (unknown ids are skipped). */
  markRead(participantId: string, messageIds: string[]): void;
  /** Whether the participant's read cursor is at or past the message (seen through inbox or thread). */
  isRead(participantId: string, messageId: string): boolean;
  /** Client-driven: marks read only the messages addressed to the agent; other ids are ignored. */
  markSeen(agentId: string, messageIds: string[]): void;
  unreadStatusBefore(agentId: string, messageId: string, limit: number): SessionDelivery[];
  /** The class the message was stored with for this participant (`action` unless status). */
  classFor(messageId: string, participantId: string): DeliveryClass;
  /** Wired once the sessions module exists: the thread's effective owner session, or null. */
  setOwnerReader(reader: (threadId: number, agentId: string) => ThreadOwner | null): void;
}

// ---------------------------------------------------------------- leases

export interface LeaseService {
  releaseForTask(taskId: number): number;
  releaseAll(holder: string): number;
}

// ---------------------------------------------------------------- tasks

export interface TaskCreateInput {
  title: string;
  description: string;
  repo?: string | undefined;
  area?: string | undefined;
  assignee?: string | undefined;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  labels: string[];
  doneWhen?: string | undefined;
  /** Internal task ids. */
  dependsOn: number[];
  baseBranch?: string | undefined;
  workflow?: string | undefined;
  parentThreadId?: number | undefined;
  planId?: number | undefined;
  prUrl?: string | undefined;
  /** Explicit reviewers (review workflow). */
  reviewers?: string[] | undefined;
  trust?: Trust;
}

export interface TaskActInput {
  note?: string | undefined;
  prUrl?: string | undefined;
  branch?: string | undefined;
  to?: string | undefined;
}

export interface TaskService {
  create(input: TaskCreateInput, actor: Actor): TaskDetail;
  act(taskId: number, action: string, input: TaskActInput, actor: Actor): TaskDetail;
  get(taskId: number, actor: Actor): TaskDetail;
  /** Load per agent: number of non-terminal tasks assigned to it. */
  activeLoad(): Map<string, number>;
  openCount(): number;
  locate(taskId: number): { threadId: number; repo: string | null } | null;
}

// ---------------------------------------------------------------- planning

export interface PlanningService {
  get(planId: number): Plan;
  activeCount(): number;
  threadOf(planId: number): number | null;
}

// ---------------------------------------------------------------- enrollment

/** What the auth callout passes on from a connecting laptop's invite code and key. */
export interface RedeemInput {
  inviteId: string;
  secret: string;
  /** The public nkey the laptop proved it holds (the callout verifies the signature). */
  nkey: string;
}

export interface EnrollmentService {
  /**
   * Single use: marks the invite used, adds the member and emits `member.joined`.
   * Any problem is refused as `unauthenticated` with no detail.
   */
  redeem(input: RedeemInput): Promise<MemberRecord>;
  /** Every member, active and revoked. */
  list(): MemberRecord[];
}

// ---------------------------------------------------------------- ingest

export interface IngestService {
  /** Stores (dedup by id), evaluates rules, runs actions. */
  accept(source: string, event: IngestEvent): Promise<{ id: string; duplicate: boolean }>;
}
