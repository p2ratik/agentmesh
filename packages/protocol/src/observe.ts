import { z } from 'zod';
import {
  ACTIVATION_PHASES,
  AUTH_EVENTS,
  DELIVERY_MODES,
  EVENT_SOURCES,
  GUARD_DECISIONS,
  HOOK_NOTES,
  HUB_DELIVERY_STAGES,
  HUB_RELAY_STAGES,
  HUB_SESSION_PHASES,
  NATS_EVENTS,
  NODE_ARCHES,
  NODE_PLATFORMS,
  ORPHAN_PHASES,
  PLUGIN_DELIVERY_STAGES,
  PLUGIN_RELAY_STAGES,
  REASON_CODES,
} from './observe-codes';
import { ParticipantId, SessionId } from './primitives';

export * from './observe-codes';

// The privacy line: ids, counts, outcomes, error codes, timings and versions. No free text anywhere.

const ThreadRef = z.string().regex(/^thr-\d{1,12}$/);
const MessageRef = z.string().regex(/^msg-[0-9A-HJKMNP-TV-Z]{26}$/);
const TaskRef = z.string().regex(/^task-\d{1,12}$/);
const PlanRef = z.string().regex(/^plan-\d{1,12}$/);
/** Tool, method, error code: a short token, never a sentence. */
const Token = z.string().regex(/^[A-Za-z0-9_.+-]{1,64}$/);
/** A version: semver-ish with build tags, and it starts with a digit, so it is never a word. */
const Version = z.string().regex(/^[0-9][0-9A-Za-z.+_-]{0,63}$/);
const Ms = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();
const Reason = z.enum(REASON_CODES);
const Time = z.iso.datetime({ offset: true }).max(40);

const common = { id: z.uuid().max(36), at: Time, session: SessionId.nullable() };
const reported = { ...common, source: z.enum(EVENT_SOURCES) };
const hub = { ...common, source: z.literal('hub') };

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** Events a plugin, its guard or its hook report (`telemetry.report`). */
export const ReportedEvent = z.discriminatedUnion('kind', [
  strict({
    ...reported,
    kind: z.literal('connected'),
    pluginVersion: Version,
    /** Null when Claude Code didn't say. */
    claudeCodeVersion: Version.nullable(),
    os: z.enum(NODE_PLATFORMS),
    arch: z.enum(NODE_ARCHES),
    node: Version,
    meshWindow: z.boolean(),
    pull: z.boolean(),
  }),
  strict({
    ...reported,
    kind: z.literal('nats'),
    event: z.enum(NATS_EVENTS),
    code: Token.optional(),
  }),
  strict({
    ...reported,
    kind: z.literal('activation'),
    phase: z.enum(ACTIVATION_PHASES),
    mode: z.enum(DELIVERY_MODES),
    reason: Reason.optional(),
  }),
  strict({
    ...reported,
    kind: z.literal('tool'),
    tool: Token,
    /** `ok` or an error code. */
    outcome: Token,
    ms: Ms,
    thread: ThreadRef.optional(),
    task: TaskRef.optional(),
    plan: PlanRef.optional(),
  }),
  strict({
    ...reported,
    kind: z.literal('delivery'),
    message: MessageRef,
    thread: ThreadRef,
    stage: z.enum(PLUGIN_DELIVERY_STAGES),
    sinceReceivedMs: Ms,
  }),
  strict({
    ...reported,
    kind: z.literal('relay'),
    message: MessageRef,
    thread: ThreadRef,
    stage: z.enum(PLUGIN_RELAY_STAGES),
    reason: Reason.optional(),
  }),
  strict({
    ...reported,
    kind: z.literal('guard'),
    tool: Token,
    decision: z.enum(GUARD_DECISIONS),
    reason: Reason,
    /** The offending key name of a `send.unknown_key`, kept only when it is a plain identifier. */
    key: z
      .string()
      .regex(/^[A-Za-z_]{1,40}$/)
      .optional(),
  }),
  strict({
    ...reported,
    kind: z.literal('hook'),
    note: z.enum(HOOK_NOTES),
    unread: Count.optional(),
  }),
  strict({ ...reported, kind: z.literal('dropped'), count: Count }),
]);
export type ReportedEvent = z.infer<typeof ReportedEvent>;

/** The hub's own events, written to the same store. */
export const HubEvent = z.discriminatedUnion('kind', [
  strict({
    ...hub,
    kind: z.literal('session'),
    phase: z.enum(HUB_SESSION_PHASES),
    replacedSession: SessionId.optional(),
    threads: z.array(ThreadRef).max(50).optional(),
  }),
  strict({
    ...hub,
    kind: z.literal('delivery'),
    message: MessageRef,
    thread: ThreadRef,
    stage: z.enum(HUB_DELIVERY_STAGES),
    code: Token.optional(),
  }),
  strict({
    ...hub,
    kind: z.literal('relay'),
    message: MessageRef,
    thread: ThreadRef,
    stage: z.enum(HUB_RELAY_STAGES),
    reason: Reason.optional(),
  }),
  strict({ ...hub, kind: z.literal('orphan'), thread: ThreadRef, phase: z.enum(ORPHAN_PHASES) }),
  strict({ ...hub, kind: z.literal('rpc'), method: Token, caller: Token, code: Token }),
  strict({
    ...hub,
    kind: z.literal('auth'),
    event: z.enum(AUTH_EVENTS),
    reason: Reason.optional(),
  }),
]);
export type HubEvent = z.infer<typeof HubEvent>;

/** What the hub stores and the timeline returns: the event, its agent and when the hub saw it. */
const stored = { agent: ParticipantId, receivedAt: Time };
export const ObservedEvent = z.union([
  ...ReportedEvent.options.map((o) => o.extend(stored)),
  ...HubEvent.options.map((o) => o.extend(stored)),
]);
export type ObservedEvent = z.infer<typeof ObservedEvent>;
