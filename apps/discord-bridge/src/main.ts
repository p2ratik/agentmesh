import { parseArgs } from 'node:util';
import { credentialsFromEnv, serversFromEnv } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import { loadConfig } from '@agentmesh/config';
import { startBridge } from './app';

/**
 * agentmesh-discord [--config <dir>]
 * Env: AGENTMESH_CONFIG, AGENTMESH_NATS_URL, AGENTMESH_NKEY_SEED (or user/pass/token),
 * plus whatever mesh.yaml references (typically DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID).
 */
async function main(): Promise<void> {
  const logger = createLogger('discord-bridge');
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  const loaded = loadConfig(values.config ?? process.env.AGENTMESH_CONFIG ?? './config');
  if (loaded.missingEnv.length > 0) {
    logger.warn({ missing: loaded.missingEnv }, 'config references unset environment variables');
  }
  const credentials = credentialsFromEnv();
  const bridge = await startBridge({
    loaded,
    servers: serversFromEnv(loaded.config.nats.servers),
    ...(credentials ? { credentials } : {}),
    logger,
  });
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    await bridge.stop().catch((err) => logger.error({ err }, 'shutdown failed'));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  createLogger('discord-bridge').fatal({ err }, 'discord bridge failed to start');
  process.exit(1);
});
