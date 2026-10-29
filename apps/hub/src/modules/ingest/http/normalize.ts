import { createHash } from 'node:crypto';
import type { IngestSource } from '@agentmesh/config';
import { IngestEvent } from '@agentmesh/protocol';
import { type Headers, header } from './auth';

/** The longest event type the mesh format accepts; raw sources get the same limit. */
const MAX_TYPE_CHARS = 120;

export type IdentifiedEvent = IngestEvent & { id: string };

export type Normalized =
  | { ok: true; event: IdentifiedEvent }
  | { ok: false; error: string; issues?: Array<{ path: string; message: string }> };

/** Event ids are namespaced by source so two producers can never collide. */
export function eventId(
  source: string,
  producerId: string | undefined,
  raw: Buffer | string,
): string {
  const id = producerId ?? createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return id.startsWith(`${source}:`) ? id : `${source}:${id}`;
}

/**
 * Turns a request body into an IngestEvent. `mesh` sources send IngestEvent
 * JSON; `raw` sources (e.g. a GitHub webhook) send anything — the body becomes
 * `payload` and the type comes from a header and/or a body field.
 */
export function normalizeEvent(source: IngestSource, headers: Headers, raw: Buffer): Normalized {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, error: 'Body must be JSON' };
  }
  if (source.format === 'mesh') {
    const parsed = IngestEvent.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Body is not a valid IngestEvent',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    return { ok: true, event: { ...parsed.data, id: eventId(source.id, parsed.data.id, raw) } };
  }
  const payload = isRecord(body) ? body : { value: body };
  const parts = [
    source.typeHeader ? header(headers, source.typeHeader) : undefined,
    source.typeField ? stringField(payload, source.typeField) : undefined,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (parts.length === 0) return { ok: false, error: 'Could not determine the event type' };
  // Rules match the type as sent, so it is not masked here, and it is never cut: a cut token
  // would no longer match where the type is posted. Too long is refused, like the mesh format.
  const joined = parts.join('.');
  if (joined.length > MAX_TYPE_CHARS) {
    return { ok: false, error: `The event type is longer than ${MAX_TYPE_CHARS} characters` };
  }
  // Other characters become `_`, which can hide a token from the patterns' word boundaries
  // (a residual risk in docs/security.md).
  const type = joined.replace(/[^A-Za-z0-9_.:-]/g, '_');
  // An HMAC signs only the body. A header id would let a captured delivery replay under new
  // ids, so a signed event's id (its dedup key) is the hash of the body it signed.
  const idHeader = source.auth.type === 'hmac-sha256' ? undefined : source.idHeader;
  const producerId = idHeader ? header(headers, idHeader) : undefined;
  return {
    ok: true,
    event: { type, severity: 'info', payload, id: eventId(source.id, producerId, raw) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === 'string' ? value : undefined;
}
