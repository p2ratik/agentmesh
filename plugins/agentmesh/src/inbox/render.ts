import type { MeshMessage } from '@agentmesh/protocol';

/** One `notifications/claude/channel` payload. */
export interface ChannelEvent {
  content: string;
  meta: Record<string, string>;
}

const META_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CONTENT = 12_000;

/**
 * Renders messages of ONE thread as one channel event. A single message is
 * its body; several become a compact transcript. Meta describes the latest
 * message (plus `count`), and `trust` is `external` if any part is external.
 * A `footer` (the FYIs riding along) ends the content, after any clipping.
 */
export function renderEvent(
  messages: readonly MeshMessage[],
  footer = '',
  maxChars = MAX_CONTENT,
): ChannelEvent {
  const last = messages.at(-1);
  if (!last) throw new Error('renderEvent needs at least one message');
  const body = clip(
    messages.length === 1 ? last.body : transcript(messages, last),
    last.threadId,
    maxChars,
  );
  return { content: footer ? `${body}\n\n${footer}` : body, meta: buildMeta(messages, last) };
}

function transcript(messages: readonly MeshMessage[], last: MeshMessage): string {
  const header = `${messages.length} new messages in ${last.threadId} «${oneLine(last.subject)}»:`;
  const entries = messages.map((m) => {
    const tags = [m.kind, m.status, m.trust === 'external' ? 'external' : null].filter(Boolean);
    return `--- ${m.from.displayName} (${tags.join(', ')}, ${m.createdAt.slice(11, 16)} UTC) ---\n${m.body}`;
  });
  return [header, ...entries].join('\n\n');
}

function clip(content: string, threadId: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n… (truncated — call thread(thread_id: "${threadId}") for the rest)`;
}

export function buildMeta(
  messages: readonly MeshMessage[],
  last: MeshMessage,
): Record<string, string> {
  const raw: Record<string, string | number | null | undefined> = {
    thread_id: last.threadId,
    message_id: last.id,
    from: last.from.id,
    from_name: last.from.displayName,
    from_kind: last.from.kind,
    kind: last.kind,
    status: last.status,
    task_id: last.refs.taskId,
    plan_id: last.refs.planId,
    round: last.refs.round,
    pr_url: last.refs.prUrl,
    verdict: last.refs.verdict,
    trust: messages.some((m) => m.trust === 'external') ? 'external' : 'team',
    depth: last.depth,
    count: messages.length > 1 ? messages.length : undefined,
    subject: oneLine(last.subject),
  };
  return sanitizeMeta(raw);
}

/** Claude Code silently drops non-identifier keys; values must be strings. */
export function sanitizeMeta(
  raw: Record<string, string | number | null | undefined>,
): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!META_KEY.test(key) || value === null || value === undefined || value === '') continue;
    meta[key] = oneLine(String(value));
  }
  return meta;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}
