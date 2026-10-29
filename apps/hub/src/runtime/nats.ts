import {
  type BusCredentials,
  connectBus,
  ensureFeedConsumer,
  ensureIngestConsumer,
  ensureStreams,
  type JetStreamClient,
  type JetStreamManager,
  jetstream,
  jetstreamManager,
  type NatsConnection,
  removeLegacyDelivery,
} from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import type { MeshConfig } from '@agentmesh/config';

const MB = 1024 * 1024;

export interface HubNats {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

export interface NatsSettings {
  servers: string[];
  credentials?: BusCredentials;
}

/** Waits for NATS (retrying forever), then opens JetStream. */
export async function connectHubNats(settings: NatsSettings, logger: Logger): Promise<HubNats> {
  const nc = await connectBus({
    servers: settings.servers,
    name: 'agentmesh-hub',
    ...(settings.credentials ? { credentials: settings.credentials } : {}),
    logger,
  });
  return { nc, js: jetstream(nc), jsm: await jetstreamManager(nc) };
}

/**
 * Streams plus a durable consumer per bridge service (activity feed) and the
 * hub's ingest reader. Idempotent; runs on every start. Agents get their
 * messages from the outbox through their sessions, not from JetStream.
 */
export async function provisionTopology(
  nats: HubNats,
  config: MeshConfig,
  logger: Logger,
): Promise<void> {
  const prefix = config.mesh.prefix;
  const { eventsMaxMB, ingestMaxMB } = config.hub.streams;
  await ensureStreams(nats.jsm, {
    prefix,
    eventRetentionDays: 7,
    ingestDedupMinutes: config.ingest.dedupWindowMinutes,
    eventsMaxBytes: eventsMaxMB * MB,
    ingestMaxBytes: ingestMaxMB * MB,
  }).catch((err: unknown) => {
    if (!/insufficient storage/i.test(String(err))) throw err;
    throw new Error(
      `NATS has no room for the mesh streams: hub.streams.eventsMaxMB + ingestMaxMB ` +
        `(${eventsMaxMB + ingestMaxMB} MB) must fit in nats.conf's max_file_store, ` +
        'next to any other streams. Lower them or raise max_file_store.',
      { cause: err },
    );
  });
  // Best-effort: a leftover stream only takes disk space.
  await removeLegacyDelivery(nats.jsm, prefix).then(
    (removed) => {
      if (removed) logger.info({ prefix }, 'removed the legacy agent delivery stream');
    },
    (err: unknown) => logger.warn({ err }, 'could not remove the legacy agent delivery stream'),
  );
  const bridges = config.services.filter((s) => s.role === 'bridge');
  for (const bridge of bridges) await ensureFeedConsumer(nats.jsm, prefix, bridge.id);
  await ensureIngestConsumer(nats.jsm, prefix);
  logger.info({ prefix, feeds: bridges.length }, 'mesh topology ready');
}
