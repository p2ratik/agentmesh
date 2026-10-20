import { redactSecrets } from '@agentmesh/common';
import type { DomainEvent } from '@agentmesh/protocol';

/**
 * Masks secrets in every string inside a value (a feed event, an RPC result).
 * The mesh channels are readable by the whole server, and the hub keeps task
 * titles, plan topics and summaries and external events as written. Mask
 * before rendering, never after: renderers truncate (a cut token is no longer
 * recognised) and compose text (`<url>`, `id: title`) that a second pass would
 * mangle. Keys and non-strings are kept. Pure.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item)]),
    ) as T;
  }
  return value;
}

/**
 * The event as the renderers see it: every string masked (`redactDeep`), except
 * - an external event's `payload`, the raw webhook body (up to 1 MB, written by
 *   outsiders). No renderer shows it, so it is dropped rather than scanned;
 * - a notice. The hub fills its template (trusted config) with values it has
 *   already masked. Masking the finished text would match across the two:
 *   `{{alarm}}: {{summary}}` lost the summary's first word after an alarm
 *   named `SecretsManager…`.
 * Pure.
 */
export function maskEvent(event: DomainEvent): DomainEvent {
  if (event.type === 'notice.posted') return event;
  if (event.type !== 'external.received') return redactDeep(event);
  const external = { ...event.data.event, payload: {} };
  return redactDeep({ ...event, data: { ...event.data, event: external } });
}
