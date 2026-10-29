import { isMeshError } from '@agentmesh/common';
import type { ParticipantRef, Severity } from '@agentmesh/protocol';

/** Discord's limits for thread names and webhook usernames. */
export const THREAD_NAME_LIMIT = 100;
export const WEBHOOK_NAME_LIMIT = 80;

/** Shortens text to `max` characters, ending with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Collapses whitespace and newlines into one line, then truncates. */
export function oneLine(text: string, max = 200): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** Marks text from outside the team (events, webhooks, issues) wherever it is posted. */
export const EXTERNAL = '🌐 external content';

/** A task's title on one line, marked when an event created the task. */
export function taskTitle(task: { title: string; trust: string }, max?: number): string {
  return `${task.trust === 'external' ? `${EXTERNAL} · ` : ''}${oneLine(task.title, max)}`;
}

/** `thr-12 · Subject` limited to Discord's 100-character thread names. */
export function threadTitle(id: string, subject: string): string {
  const clean = oneLine(subject, THREAD_NAME_LIMIT);
  return truncate(clean ? `${id} · ${clean}` : id, THREAD_NAME_LIMIT);
}

/**
 * The name a participant's message is posted under. Agents and humans get a
 * suffix so readers can tell them apart; Discord rejects webhook names that
 * contain "discord" or "clyde", so those words are removed.
 */
export function webhookUsername(ref: ParticipantRef): string {
  const clean = (text: string) => oneLine(text.replace(/discord|clyde/gi, ''), WEBHOOK_NAME_LIMIT);
  const base = clean(ref.displayName) || clean(ref.id) || 'AgentMesh';
  const mentionsKind = base.toLowerCase().includes(ref.kind);
  const suffix = ref.kind === 'service' || mentionsKind ? '' : ` (${ref.kind})`;
  return `${truncate(base, WEBHOOK_NAME_LIMIT - suffix.length)}${suffix}`;
}

/** Wraps a URL in angle brackets so Discord links it without a preview embed. */
export const link = (url: string): string => `<${url}>`;

/** Discord renders this as a localized, relative time ("in 15 minutes"). */
export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : `<t:${Math.floor(ms / 1000)}:R>`;
}

/** `a, b, c +2 more` */
export function list(items: readonly string[], max = 10): string {
  if (items.length === 0) return 'none';
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} +${items.length - max} more` : shown;
}

export const SEVERITY_EMOJI: Record<Severity, string> = {
  debug: '⚪',
  info: '🔵',
  warning: '🟡',
  error: '🔴',
  critical: '🚨',
};

const SEVERITY_RANK: Record<Severity, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

export const isAtLeast = (severity: Severity, floor: Severity): boolean =>
  SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];

/** How a failed mesh call is shown to the Discord user. */
export function errorText(error: unknown): string {
  if (isMeshError(error)) return `⚠️ ${error.code}: ${error.message}`;
  return '⚠️ internal: something went wrong in the Discord bridge. Check its logs.';
}
