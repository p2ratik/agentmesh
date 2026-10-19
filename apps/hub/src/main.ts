import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { credentialsFromEnv, serversFromEnv } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import { loadConfig } from '@agentmesh/config';
import { createHub } from './app';
import { loadCalloutKeys } from './modules/callout';

/**
 * agentmesh-hub [--config <dir>]
 * Env: AGENTMESH_CONFIG, AGENTMESH_DATA_DIR, AGENTMESH_NATS_URL (comma-separated),
 * AGENTMESH_NKEY_SEED (seed or file) | AGENTMESH_NATS_USER/AGENTMESH_NATS_PASS | AGENTMESH_NATS_TOKEN,
 * AGENTMESH_SECRETS_DIR (auth-callout mode: holds <hubId>-issuer.nk, -xkey.nk and -sys.nk).
 */
async function main(): Promise<void> {
  const logger = createLogger('hub');
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  const loaded = loadConfig(values.config ?? process.env.AGENTMESH_CONFIG ?? './config');
  const { config } = loaded;
  if (loaded.missingEnv.length > 0) {
    logger.warn({ missing: loaded.missingEnv }, 'config references unset environment variables');
  }
  const dataDir = process.env.AGENTMESH_DATA_DIR ?? resolve(loaded.dir, config.hub.dataDir);
  const credentials = credentialsFromEnv();
  const hub = await createHub({
    loaded,
    dataDir,
    nats: {
      servers: serversFromEnv(config.nats.servers),
      ...(credentials ? { credentials } : {}),
    },
    callout: loadCalloutKeys(config.hub, process.env.AGENTMESH_SECRETS_DIR),
    logger,
  });
  await hub.start();
  logger.info(
    {
      mesh: config.mesh.name,
      prefix: config.mesh.prefix,
      agents: hub.context.index.agents().map((a) => a.id),
      dataDir,
    },
    'agentmesh hub started',
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    await hub.stop().catch((err) => logger.error({ err }, 'shutdown failed'));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  createLogger('hub').fatal({ err }, 'hub failed to start');
  process.exit(1);
});
