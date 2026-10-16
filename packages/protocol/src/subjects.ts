/**
 * NATS topology. Every name derives from a configurable prefix so several
 * meshes can share one NATS server.
 *
 *   {p}.rpc.{caller}.{method…}   request/reply from a participant to the hub
 *   {p}.presence.{id}            fire-and-forget heartbeats
 *   {p}.deliver.{id}             JetStream: per-participant durable inbox
 *   {p}.evt.{type…}              JetStream: activity feed consumed by bridges
 *   {p}.ingest.{source}          JetStream: external events for the rules engine
 */
export const PREFIX_PATTERN = /^[a-z][a-z0-9_-]{0,30}$/;

export interface Subjects {
  prefix: string;
  rpc(caller: string, method: string): string;
  rpcAll: string;
  presence(id: string): string;
  presenceAll: string;
  deliver(id: string): string;
  deliverAll: string;
  event(type: string): string;
  eventAll: string;
  ingest(source: string): string;
  ingestAll: string;
}

export function subjects(prefix: string): Subjects {
  if (!PREFIX_PATTERN.test(prefix)) throw new Error(`Invalid subject prefix "${prefix}"`);
  return {
    prefix,
    rpc: (caller, method) => `${prefix}.rpc.${caller}.${method}`,
    rpcAll: `${prefix}.rpc.>`,
    presence: (id) => `${prefix}.presence.${id}`,
    presenceAll: `${prefix}.presence.*`,
    deliver: (id) => `${prefix}.deliver.${id}`,
    deliverAll: `${prefix}.deliver.>`,
    event: (type) => `${prefix}.evt.${type}`,
    eventAll: `${prefix}.evt.>`,
    ingest: (source) => `${prefix}.ingest.${source}`,
    ingestAll: `${prefix}.ingest.>`,
  };
}

/** Splits `{p}.rpc.{caller}.{method…}` into its parts, or returns null. */
export function parseRpcSubject(
  prefix: string,
  subject: string,
): { caller: string; method: string } | null {
  const head = `${prefix}.rpc.`;
  if (!subject.startsWith(head)) return null;
  const rest = subject.slice(head.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { caller: rest.slice(0, dot), method: rest.slice(dot + 1) };
}

export function parseTokenAfter(prefix: string, kind: string, subject: string): string | null {
  const head = `${prefix}.${kind}.`;
  if (!subject.startsWith(head)) return null;
  const token = subject.slice(head.length);
  return token.length > 0 && !token.includes('.') ? token : null;
}

export interface StreamNames {
  delivery: string;
  events: string;
  ingest: string;
}

export function streamNames(prefix: string): StreamNames {
  const p = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return { delivery: `${p}_DELIVERY`, events: `${p}_EVENTS`, ingest: `${p}_INGEST` };
}

export const consumerNames = {
  /** Durable inbox of one participant on the delivery stream. */
  inbox: (participantId: string) => `inbox-${participantId}`,
  /** Durable activity-feed reader for a bridge service. */
  feed: (serviceId: string) => `feed-${serviceId}`,
  /** The hub's reader of the ingest stream. */
  ingest: 'hub-ingest',
};

/** Per-participant inbox prefix, so a client can only see its own RPC replies. */
export const inboxPrefix = (participantId: string): string => `_INBOX_${participantId}`;
