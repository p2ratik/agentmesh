import { MeshError, redactSecrets } from '@agentmesh/common';
import type { MessageRefs } from '@agentmesh/protocol';
import type { Actor, PostResult, RpcHandlerMap } from '../../contracts';
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

export function sendHandlers(messaging: MessagingServiceImpl): SendHandlers {
  const { db, index } = messaging.ctx;
  return {
    'message.send': (params, call) => {
      const { actor } = call;
      const message = {
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
      };
      const result: PostResult = db.transaction(() => {
        const tokens = params.to ?? [];
        const recipients = expandRecipients(tokens, actor.id, directory(messaging));
        if (params.toSession) assertPick(messaging, params.toSession, recipients);
        if (params.threadId) {
          const threadId = internalId('thread', params.threadId);
          assertCanPost(messaging, threadId, actor);
          messaging.addParticipants(threadId, recipients);
          return messaging.post({ ...message, threadId });
        }
        if (recipients.length === 0) throw noRecipientsError(tokens, actor.id);
        const threadId = startThread(messaging, actor, {
          kind: 'conversation',
          subject:
            params.subject === undefined
              ? firstLine(redactSecrets(params.body), MAX_AUTO_SUBJECT)
              : redactSecrets(params.subject),
          to: recipients,
          ...(params.parentThreadId ? { parent: params.parentThreadId } : {}),
        });
        return messaging.post({ ...message, threadId });
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
