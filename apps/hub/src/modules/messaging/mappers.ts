import type { MeshMessage, MessageRefs, ParticipantRef, ThreadSummary } from '@agentmesh/protocol';
import type { ThreadRecord } from '../../contracts';
import { optionalKey, threadKey } from '../../core/ids';
import { fromJson } from '../../db/database';
import type { MessageRow } from './messages.repo';

export function toThreadSummary(thread: ThreadRecord, participants: string[]): ThreadSummary {
  return {
    id: threadKey(thread.id),
    kind: thread.kind,
    subject: thread.subject,
    createdBy: thread.createdBy,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    depth: thread.depth,
    parentId: optionalKey('thread', thread.parentId),
    participants,
    taskId: optionalKey('task', thread.taskId),
    planId: optionalKey('plan', thread.planId),
    status: thread.status,
    messageCount: thread.messageCount,
  };
}

export function toMeshMessage(row: MessageRow, from: ParticipantRef): MeshMessage {
  return {
    id: row.id,
    threadId: threadKey(row.thread_id),
    kind: row.kind,
    from,
    to: fromJson<string[]>(row.recipients, []),
    subject: row.subject,
    body: row.body,
    status: row.status,
    trust: row.trust,
    depth: row.depth,
    refs: fromJson<MessageRefs>(row.refs, {}),
    createdAt: row.created_at,
  };
}

/** Thread links (task, plan) first, so explicit refs on the post can refine them. */
export function messageRefs(thread: ThreadRecord, refs: MessageRefs | undefined): MessageRefs {
  const taskId = optionalKey('task', thread.taskId);
  const planId = optionalKey('plan', thread.planId);
  return {
    ...(taskId ? { taskId } : {}),
    ...(planId ? { planId } : {}),
    ...refs,
  };
}

/** The first line of a body, trimmed to `max` chars, for auto-generated subjects. */
export function firstLine(text: string, max: number): string {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
