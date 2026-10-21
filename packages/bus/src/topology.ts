import { consumerNames, streamNames, subjects } from '@agentmesh/protocol';
import {
  AckPolicy,
  type ConsumerConfig,
  DeliverPolicy,
  type JetStreamManager,
  RetentionPolicy,
  StorageType,
  type StreamConfig,
} from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface TopologyOptions {
  prefix: string;
  eventRetentionDays: number;
  ingestDedupMinutes: number;
}

/** Creates or updates the mesh streams. Safe to run on every hub start. */
export async function ensureStreams(
  jsm: JetStreamManager,
  options: TopologyOptions,
): Promise<void> {
  const names = streamNames(options.prefix);
  const subs = subjects(options.prefix);
  await upsertStream(jsm, {
    name: names.events,
    subjects: [subs.eventAll],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: nanos(options.eventRetentionDays * DAY_MS),
    duplicate_window: nanos(2 * MINUTE_MS),
  });
  await upsertStream(jsm, {
    name: names.ingest,
    subjects: [subs.ingestAll],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_age: nanos(7 * DAY_MS),
    duplicate_window: nanos(options.ingestDedupMinutes * MINUTE_MS),
  });
}

async function upsertStream(
  jsm: JetStreamManager,
  config: Partial<StreamConfig> & { name: string },
): Promise<void> {
  try {
    await jsm.streams.info(config.name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await jsm.streams.add(config);
    return;
  }
  const { name, ...update } = config;
  await jsm.streams.update(name, update);
}

/**
 * Deletes the stream that held agents' inboxes before per-session delivery
 * (the hub's outbox holds them now). Returns whether it existed.
 */
export async function removeLegacyDelivery(
  jsm: JetStreamManager,
  prefix: string,
): Promise<boolean> {
  try {
    return await jsm.streams.delete(streamNames(prefix).delivery);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Durable reader of the activity feed for a bridge. Starts at new events. */
export function ensureFeedConsumer(
  jsm: JetStreamManager,
  prefix: string,
  serviceId: string,
): Promise<void> {
  return upsertConsumer(jsm, streamNames(prefix).events, {
    durable_name: consumerNames.feed(serviceId),
    filter_subject: subjects(prefix).eventAll,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    ack_wait: nanos(60_000),
    max_deliver: 10,
    max_ack_pending: 100,
  });
}

/** The hub's reader of external events. */
export function ensureIngestConsumer(jsm: JetStreamManager, prefix: string): Promise<void> {
  return upsertConsumer(jsm, streamNames(prefix).ingest, {
    durable_name: consumerNames.ingest,
    filter_subject: subjects(prefix).ingestAll,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    ack_wait: nanos(60_000),
    max_deliver: 5,
    max_ack_pending: 50,
  });
}

async function upsertConsumer(
  jsm: JetStreamManager,
  stream: string,
  config: Partial<ConsumerConfig> & { durable_name: string },
): Promise<void> {
  try {
    await jsm.consumers.info(stream, config.durable_name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await jsm.consumers.add(stream, config);
    return;
  }
  const { durable_name, filter_subject, deliver_policy, ...mutable } = config;
  await jsm.consumers.update(stream, durable_name, mutable);
}

function isNotFound(error: unknown): boolean {
  const text = `${(error as Error)?.name ?? ''} ${(error as Error)?.message ?? ''}`.toLowerCase();
  return text.includes('not found') || text.includes('10059') || text.includes('10014');
}
