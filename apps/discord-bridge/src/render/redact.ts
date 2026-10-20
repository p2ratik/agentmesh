import { redactSecrets } from '@agentmesh/common';
import type { DomainEvent } from '@agentmesh/protocol';

/**
 * Masks secrets in every string inside a value (a feed event, an RPC result).
 * The mesh channels are readable by the whole server, and only mesh messages
 * are redacted by the hub: task titles, plan topics and summaries, notices and
 * external events arrive as written. Mask before rendering, never after:
 * renderers truncate (a cut token is no longer recognised) and compose text
 * (`<url>`, `id: title`) that a second pass would mangle. Keys and
 * non-strings are kept. Pure.
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
 * The event without fields no renderer shows. An external event's `payload`
 * is the raw webhook body (up to 1 MB, written by outsiders): masking it would
 * only cost time, so it is dropped before `redactDeep`. Pure.
 */
export function renderedFields(event: DomainEvent): DomainEvent {
  if (event.type !== 'external.received') return event;
  return { ...event, data: { ...event.data, event: { ...event.data.event, payload: {} } } };
}
