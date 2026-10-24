import {
  type BusCredentials,
  connectBus,
  jetstream,
  type NatsConnection,
  RpcClient,
} from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import type { LoadedConfig } from '@agentmesh/config';
import { inboxPrefix } from '@agentmesh/protocol';
import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { commandDefinitions } from './commands/definitions';
import { createInteractionHandler } from './commands/router';
import { provisionChannels } from './discord/provision';
import { ThreadMirror } from './discord/threads';
import { WebhookCache } from './discord/webhooks';
import { EchoGuard } from './echo';
import { runFeed } from './feed/consumer';
import { Executor } from './feed/executor';
import { createReplyRelay } from './inbound/replies';
import { TeamIndex } from './team';

export interface BridgeOptions {
  loaded: LoadedConfig;
  servers: string[];
  credentials?: BusCredentials;
  logger: Logger;
}

export interface Bridge {
  stop(): Promise<void>;
}

/**
 * Connects to the mesh as the configured bridge service and to Discord as the
 * bot; provisions channels, registers slash commands, then mirrors the feed
 * and relays humans' commands and replies.
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const { config } = options.loaded;
  const discord = config.discord;
  if (!discord.enabled) throw new Error('discord.enabled is false in mesh.yaml');
  const { logger } = options;
  const team = new TeamIndex(config);
  const index = () => team.current;

  const nc: NatsConnection = await connectBus({
    servers: options.servers,
    name: 'agentmesh-discord',
    inboxPrefix: inboxPrefix(discord.serviceId),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    logger,
  });
  const rpc = new RpcClient(nc, config.mesh.prefix, discord.serviceId);
  const abort = new AbortController();
  const refreshTeam = async () => {
    const active = await team.refresh(rpc);
    logger.info({ members: active }, 'team index refreshed');
  };
  // Not fatal, and not waited for: until the hub answers, only mesh.yaml members can use the bridge.
  void team
    .load(rpc, {
      signal: abort.signal,
      onRetry: (err, attempt, delayMs) =>
        logger.warn({ err, attempt, delayMs }, 'could not load enrolled members yet; retrying'),
    })
    .then((active) => logger.info({ members: active }, 'team index refreshed'))
    .catch(() => undefined); // only when the bridge stops

  await new REST()
    .setToken(discord.token)
    .put(Routes.applicationGuildCommands(discord.applicationId, discord.guildId), {
      body: commandDefinitions(),
    });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(discord.token);
  await ready;
  const guild = await client.guilds.fetch(discord.guildId);
  const directory = await provisionChannels(guild, discord, logger);

  const echo = new EchoGuard();
  const threads = new ThreadMirror(rpc, client, logger);
  const executor = new Executor({
    client,
    directory,
    webhooks: new WebhookCache(),
    threads,
    logger,
  });
  const enrolled = () => team.enrolled(new Date());
  // After /mesh invite or uninvite: no hub event marks an invite opening or closing.
  const refreshInvites = () =>
    refreshTeam().catch((err: unknown) =>
      logger.warn({ err }, 'could not refresh open invites; autocomplete may be stale'),
    );
  client.on(
    Events.InteractionCreate,
    createInteractionHandler({ rpc, index, enrolled, refreshInvites, directory, logger }),
  );
  client.on(Events.MessageCreate, createReplyRelay({ rpc, index, threads, echo, logger }));

  void runFeed({
    js: jetstream(nc),
    prefix: config.mesh.prefix,
    serviceId: discord.serviceId,
    index,
    onMembersChanged: refreshTeam,
    executor,
    echo,
    logger,
    signal: abort.signal,
  });
  logger.info({ guild: guild.name, mesh: config.mesh.name }, 'discord bridge ready');

  return {
    async stop() {
      abort.abort();
      await client.destroy();
      await nc.drain().catch(() => undefined);
    },
  };
}
