import type { ConfigIndex } from '@agentmesh/config';
import type {
  DomainEventData,
  MeshMessage,
  MessageRefs,
  ReplyStatus,
  ThreadKind,
  ThreadSummary,
} from '@agentmesh/protocol';
import { avatarFor } from './avatars';
import { link, oneLine, threadTitle, truncate, webhookUsername } from './format';
import type { PostIntent, ThreadTarget } from './intents';
import { names } from './people';

/** Kinds that are always addressed to someone, so they always show `→ recipient`. */
const ADDRESSED_KINDS: ReadonlySet<MeshMessage['kind']> = new Set([
  'ask',
  'broadcast',
  'escalation',
]);

/** Which purpose channel holds each kind of mesh thread. */
export const PURPOSE_BY_THREAD_KIND: Record<ThreadKind, string> = {
  conversation: 'council',
  task: 'tasks',
  planning: 'planning',
  escalation: 'escalations',
  event: 'alerts',
};

const STATUS_BADGE: Record<ReplyStatus, string> = {
  answer: '💬 answer',
  accepted: '👍 accepted',
  declined: '🙅 declined',
  working: '🛠️ working',
  blocked: '⛔ blocked',
  done: '✅ done',
  needs_human: '🙋 needs human',
  info: 'ℹ️ info',
};

const VERDICT_BADGE: Record<string, string> = {
  approve: '✅ approved',
  request_changes: '🛠️ changes requested',
  comment: '💬 comment',
};

/** Mirrors a mesh message into the Discord thread for its mesh thread. */
export function renderMessageCreated(
  data: DomainEventData<'message.created'>,
  index: ConfigIndex,
): PostIntent[] {
  const { message, thread } = data;
  const mentionUserIds = thread.kind === 'escalation' ? humanTargets(message, index) : [];
  const mentions = mentionUserIds.map((id) => `<@${id}>`).join(' ');
  const header = messageHeader(message, addressee(message, thread, index));
  const content = [mentions, header, message.body].filter(Boolean).join('\n');
  const avatarURL = avatarFor(message.from, index);
  return [
    {
      purpose: PURPOSE_BY_THREAD_KIND[thread.kind],
      thread: threadTarget(thread, index),
      username: webhookUsername(message.from),
      ...(avatarURL ? { avatarURL } : {}),
      content,
      ...(mentionUserIds.length > 0 ? { mentionUserIds } : {}),
    },
  ];
}

/** Planning threads are titled by plan id (`plan-7 · topic`), all others by thread id. */
export function threadTarget(thread: ThreadSummary, index: ConfigIndex): ThreadTarget {
  const id = thread.kind === 'planning' && thread.planId ? thread.planId : thread.id;
  const who = thread.participants.length > 0 ? ` — ${names(index, thread.participants)}` : '';
  return {
    threadId: thread.id,
    title: threadTitle(id, thread.subject),
    starter: truncate(`🧵 ${oneLine(`${id} · ${thread.subject}`, 300)}${who}`, 2000),
  };
}

/**
 * Who a message is for, as `→ Bob's agent`. Shown for asks, broadcasts and
 * escalations, and for any message that reaches only part of its thread (or
 * people outside it), so multi-agent threads read like a conversation.
 * Empty when a message simply goes to everyone else in the thread.
 */
export function addressee(message: MeshMessage, thread: ThreadSummary, index: ConfigIndex): string {
  const to = message.to.filter((id) => id !== message.from.id);
  if (to.length === 0) return '';
  const others = thread.participants.filter((id) => id !== message.from.id);
  const everyoneElse = to.length === others.length && to.every((id) => others.includes(id));
  if (everyoneElse && !ADDRESSED_KINDS.has(message.kind)) return '';
  return `→ ${names(index, to)}`;
}

/** One line of badges: trust, kind and addressee, status and references. Empty for a plain reply. */
export function messageHeader(message: MeshMessage, to = ''): string {
  const kind = message.kind === 'reply' ? '' : `**[${message.kind}]**`;
  return [
    message.trust === 'external' ? '🌐 external content' : '',
    [kind, to].filter(Boolean).join(' '),
    message.status ? STATUS_BADGE[message.status] : '',
    ...refBadges(message.refs),
  ]
    .filter(Boolean)
    .join(' · ');
}

function refBadges(refs: MessageRefs): string[] {
  return [
    refs.taskId ?? '',
    refs.round ? `round ${refs.round}` : '',
    refs.verdict ? (VERDICT_BADGE[refs.verdict] ?? refs.verdict) : '',
    refs.prUrl ? `PR ${link(refs.prUrl)}` : '',
  ];
}

/** Humans an escalation is addressed to, as Discord user ids. */
function humanTargets(message: MeshMessage, index: ConfigIndex): string[] {
  const ids = message.to
    .map((id) => index.human(id)?.discordUserId)
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}
