import {
  type BusCredentials,
  connectBus,
  ensureFeedConsumer,
  ensureInboxConsumer,
  ensureIngestConsumer,
  ensureStreams,
  type JetStreamClient,
  type JetStreamManager,
  jetstream,
  jetstreamManager,
  type NatsConnection,
} from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import type { MeshConfig } from '@agentmesh/config';

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
 * Streams plus a durable consumer per configured agent (inbox), bridge
 * service (activity feed) and the hub's ingest reader. Idempotent; runs on
 * every start so new teammates get an inbox without manual steps.
 */
export async function provisionTopology(
  nats: HubNats,
  config: MeshConfig,
  logger: Logger,
): Promise<void> {
  const prefix = config.mesh.prefix;
  await ensureStreams(nats.jsm, {
    prefix,
    deliveryRetentionDays: config.limits.deliveryRetentionDays,
    eventRetentionDays: 7,
    ingestDedupMinutes: config.ingest.dedupWindowMinutes,
  });
  for (const agent of config.agents) await ensureInboxConsumer(nats.jsm, prefix, agent.id);
  const bridges = config.services.filter((s) => s.role === 'bridge');
  for (const bridge of bridges) await ensureFeedConsumer(nats.jsm, prefix, bridge.id);
  await ensureIngestConsumer(nats.jsm, prefix);
  logger.info(
    { prefix, inboxes: config.agents.length, feeds: bridges.length },
    'mesh topology ready',
  );
}
