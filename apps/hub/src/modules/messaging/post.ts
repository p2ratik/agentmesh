import { createHash } from 'node:crypto';
import { DAY_MS, HOUR_MS, MeshError, newMessageId } from '@agentmesh/common';
import type { MeshMessage, ParticipantRef, ThreadSummary } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { ControlService, PostInput, PostResult, ThreadRecord } from '../../contracts';
import { threadKey } from '../../core/ids';
import { toJson } from '../../db/database';
import { postLimitViolation } from './limits';
import { messageRefs } from './mappers';
import type { MessagesRepo } from './messages.repo';
import type { ReadsRepo } from './reads.repo';
import { redactSecrets } from './redact';
import type { ThreadsRepo } from './threads.repo';

/** What the post pipeline needs from the messaging service. */
export interface PostContext {
  ctx: HubContext;
  control: ControlService;
  hubId: string;
  threads: ThreadsRepo;
  messages: MessagesRepo;
  reads: ReadsRepo;
  thread(threadId: number): ThreadRecord;
  summary(threadId: number): ThreadSummary;
  refOf(participantId: string): ParticipantRef;
  assertKnown(participantIds: readonly string[]): void;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Stores one message and queues its side effects: redaction, limits (skipped
 * for system posts), recipients, read cursor, agent deliveries (held while
 * paused) and the `message.created` feed event. Runs inside the caller's
 * transaction when there is one.
 */
export function postMessage(pc: PostContext, input: PostInput): PostResult {
  const { db, clock, outbox, index } = pc.ctx;
  const result = db.transaction(() => {
    const thread = pc.thread(input.threadId);
    const now = clock.now();
    const at = now.toISOString();
    if (input.senderId !== pc.hubId) pc.assertKnown([input.senderId]);
    const body = redactSecrets(input.body);
    const bodyHash = sha256(body);
    if (!input.system) enforceLimits(pc, thread, input, bodyHash, now);

    const recipients = resolveRecipients(pc, thread, input, at);
    const message: MeshMessage = {
      id: newMessageId(),
      threadId: threadKey(thread.id),
      kind: input.kind,
      from: pc.refOf(input.senderId),
      to: recipients,
      subject: thread.subject,
      body,
      status: input.status ?? null,
      trust: input.trust ?? 'team',
      depth: thread.depth,
      refs: messageRefs(thread, input.refs),
      createdAt: at,
    };
    const seq = pc.messages.insert({
      id: message.id,
      threadId: thread.id,
      senderId: input.senderId,
      kind: message.kind,
      body,
      bodyHash,
      status: message.status,
      trust: message.trust,
      depth: message.depth,
      recipients: toJson(recipients),
      refs: toJson(message.refs),
      at,
    });
    pc.threads.recordMessage(thread.id, at);
    pc.reads.advance(thread.id, input.senderId, seq);

    const held = pc.control.isPaused();
    const deliveredTo = recipients.filter((id) => index.kindOf(id) === 'agent');
    for (const id of deliveredTo) outbox.enqueueDelivery(message, id, held);
    outbox.enqueueEvent('message.created', { message, thread: pc.summary(thread.id) });
    return { message, deliveredTo, held };
  });
  outbox.kick();
  return result;
}

function enforceLimits(
  pc: PostContext,
  thread: ThreadRecord,
  input: PostInput,
  bodyHash: string,
  now: Date,
): void {
  if (thread.status === 'closed') {
    throw new MeshError('conflict', `Thread ${threadKey(thread.id)} is closed`);
  }
  const limits = pc.ctx.loaded.config.limits;
  const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const violation = postLimitViolation(
    {
      bodyChars: input.body.length,
      threadLastHour: pc.messages.countInThreadSince(thread.id, since(HOUR_MS), pc.hubId),
      senderLastDay: pc.messages.countBySenderSince(input.senderId, since(DAY_MS)),
      duplicate:
        limits.dedupWindowSeconds > 0 &&
        pc.messages.hasDuplicate(
          thread.id,
          input.senderId,
          bodyHash,
          since(limits.dedupWindowSeconds * 1000),
        ),
    },
    limits,
  );
  if (violation) throw violation;
}

/**
 * Omitted `to`: every participant but the sender. `[]`: nobody. A list: those
 * ids. Anyone no longer on the team is skipped: they stay in the threads they
 * were in (and get them back if they rejoin), but they no longer block posts.
 * Callers validate ids that come from requests before they get here.
 */
function resolveRecipients(
  pc: PostContext,
  thread: ThreadRecord,
  input: PostInput,
  at: string,
): string[] {
  const named = input.to === undefined ? pc.threads.participants(thread.id) : input.to;
  const wanted = [...new Set(named)].filter((id) => id !== input.senderId);
  const recipients = wanted.filter((id) => pc.ctx.index.kindOf(id) !== undefined);
  if (recipients.length < wanted.length) {
    const skipped = wanted.filter((id) => !recipients.includes(id));
    // A named recipient going missing means a brief or request may reach nobody: worth seeing.
    const level = input.to === undefined ? 'debug' : 'info';
    pc.ctx.logger[level]({ threadId: thread.id, skipped }, 'skipped recipients not on the team');
  }
  if (input.to !== undefined && input.addToThread !== false) {
    pc.threads.addParticipants(thread.id, recipients, at);
  }
  return recipients;
}
