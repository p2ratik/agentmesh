import { MeshError, redactSecrets } from '@agentmesh/common';
import type { DeliveryClass, MessageRefs, RpcParams } from '@agentmesh/protocol';
import type { Actor, PostInput, PostResult, RpcHandlerMap } from '../../contracts';
import { internalId, taskKey } from '../../core/ids';
import { firstLine } from './mappers';
import type { MessagingServiceImpl } from './messaging.service';
import { expandRecipients, noRecipientsError, type RecipientDirectory } from './recipients';

type SendHandlers = Pick<RpcHandlerMap, 'message.send' | 'escalate'>;

/**
 * Subjects are redacted here, where they come in: `createThread` and auto
 * subjects cut them, and a cut token no longer matches.
 */
const MAX_AUTO_SUBJECT = 80;

/** Normalizes a protocol task id (`42`, `TASK-42`) into a message ref. */
function taskRefs(taskId: string | undefined): MessageRefs {
  return taskId ? { taskId: taskKey(internalId('task', taskId)) } : {};
}

function directory(messaging: MessagingServiceImpl): RecipientDirectory {
  const { index } = messaging.ctx;
  return {
    agents: index.agents().map((a) => a.id),
    isAddressable: (id) => index.kindOf(id) === 'agent' || index.kindOf(id) === 'human',
    isOnline: (id) => messaging.deps.presence.isOnline(id),
  };
}

/** Agents may only post into threads they are part of; humans may post anywhere. */
function assertCanPost(messaging: MessagingServiceImpl, threadId: number, actor: Actor): void {
  messaging.thread(threadId);
  if (actor.kind === 'agent' && !messaging.isParticipant(threadId, actor.id)) {
    throw new MeshError('forbidden', 'You are not a participant of this thread');
  }
}

/** A sender's session pick: one agent recipient, and an active session of that agent. */
function assertPick(messaging: MessagingServiceImpl, sessionId: string, recipients: string[]) {
  const [agent] = recipients;
  if (recipients.length !== 1 || !agent || messaging.ctx.index.kindOf(agent) !== 'agent') {
    throw new MeshError('invalid_request', '`toSession` needs exactly one agent in `to`');
  }
  if (!messaging.deps.isActiveSessionOf(agent, sessionId)) {
    throw new MeshError('invalid_request', `${sessionId} is not an active session of ${agent}`);
  }
}

/** Starts a thread; humans always start fresh chains (depth 0), agents inherit their parent's. */
function startThread(
  messaging: MessagingServiceImpl,
  actor: Actor,
  input: { kind: 'conversation' | 'escalation'; subject: string; to: string[]; parent?: string },
): number {
  const parent =
    actor.kind === 'human' || input.parent === undefined
      ? null
      : internalId('thread', input.parent);
  return messaging.createThread({
    kind: input.kind,
    subject: input.subject,
    createdBy: actor.id,
    participants: input.to,
    parentThreadId: parent,
  }).id;
}

type SendParams = RpcParams<'message.send'>;

/**
 * A teammate message is status only when it is a progress report (a `working`
 * or `info` reply); a question or any other answer always needs its reader.
 */
function sendClass(params: SendParams): DeliveryClass {
  const report = params.status === 'working' || params.status === 'info';
  return params.kind === 'reply' && report ? 'status' : 'action';
}

/** What a `message.send` posts, minus its thread. */
function sendInput(params: SendParams, actor: Actor): Omit<PostInput, 'threadId'> {
  return {
    senderId: actor.id,
    kind: params.kind,
    body: params.body,
    status: params.status ?? null,
    refs: {
      ...taskRefs(params.taskId),
      ...(params.prUrl ? { prUrl: params.prUrl } : {}),
      ...(params.repo ? { repo: params.repo } : {}),
      ...(params.toSession ? { session: params.toSession } : {}),
    },
    deliveryClass: sendClass(params),
  };
}

/** The thread a `message.send` posts into: the one it names, or a new one with its recipients. */
function sendThread(
  messaging: MessagingServiceImpl,
  params: SendParams,
  actor: Actor,
  recipients: string[],
): number {
  if (params.threadId) {
    const threadId = internalId('thread', params.threadId);
    assertCanPost(messaging, threadId, actor);
    messaging.addParticipants(threadId, recipients);
    return threadId;
  }
  if (recipients.length === 0) throw noRecipientsError(params.to ?? [], actor.id);
  return startThread(messaging, actor, {
    kind: 'conversation',
    subject:
      params.subject === undefined
        ? firstLine(redactSecrets(params.body), MAX_AUTO_SUBJECT)
        : redactSecrets(params.subject),
    to: recipients,
    ...(params.parentThreadId ? { parent: params.parentThreadId } : {}),
  });
}

export function sendHandlers(messaging: MessagingServiceImpl): SendHandlers {
  const { db } = messaging.ctx;
  return {
    'message.send': (params, call) => {
      const { actor } = call;
      const input = sendInput(params, actor);
      const result: PostResult = db.transaction(() => {
        const recipients = expandRecipients(params.to ?? [], actor.id, directory(messaging));
        if (params.toSession) assertPick(messaging, params.toSession, recipients);
        const threadId = sendThread(messaging, params, actor, recipients);
        return messaging.post({ ...input, threadId });
      });
      return {
        messageId: result.message.id,
        threadId: result.message.threadId,
        deliveredTo: result.deliveredTo,
        held: result.held,
      };
    },

    /** Pings a human (the agent's owner by default) in an existing or new escalation thread. */
    escalate: (params, call) => {
      const { actor } = call;
      // Read per call: people who joined by invite since the hub started can escalate and be pinged.
      const { index } = messaging.ctx;
      const to = params.to ?? index.agent(actor.id)?.owner;
      if (!to || index.kindOf(to) !== 'human') {
        throw new MeshError('invalid_request', 'Escalations must go to a configured human');
      }
      const body = params.urgent ? `URGENT: ${params.question}` : params.question;
      const result = db.transaction(() => {
        let threadId: number;
        if (params.threadId) {
          threadId = internalId('thread', params.threadId);
          assertCanPost(messaging, threadId, actor);
          messaging.addParticipants(threadId, [to]);
        } else {
          threadId = startThread(messaging, actor, {
            kind: 'escalation',
            subject: firstLine(redactSecrets(params.question), MAX_AUTO_SUBJECT),
            to: [to],
          });
        }
        return messaging.post({
          threadId,
          senderId: actor.id,
          kind: 'escalation',
          body,
          status: 'needs_human',
          refs: taskRefs(params.taskId),
        });
      });
      return { threadId: result.message.threadId, messageId: result.message.id };
    },
  };
}
