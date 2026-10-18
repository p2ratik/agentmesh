import { join } from 'node:path';
import {
  deleteInboxConsumer,
  ensureInboxConsumer,
  type RpcDispatcher,
  serveRpc,
} from '@agentmesh/bus';
import { type Clock, createLogger, DAY_MS, type Logger, systemClock } from '@agentmesh/common';
import { ConfigIndex, type LoadedConfig } from '@agentmesh/config';
import { createHubContext, type HubContext } from './context';
import { NatsPorts } from './core/nats-ports';
import { SqliteOutbox } from './core/outbox';
import { Db } from './db/database';
import { migrate } from './db/migrate';
import { createNatsIngestTransport } from './modules/ingest';
import { type Subscription, startPresenceListener } from './modules/presence';
import { type DeliveryPort, type EventPort, MemoryPorts } from './ports';
import { IdempotencyStore } from './rpc/idempotency';
import { createRpcRouter } from './rpc/router';
import { buildModules, type HubServices } from './runtime/modules';
import { connectHubNats, type HubNats, type NatsSettings, provisionTopology } from './runtime/nats';
import { Scheduler } from './scheduler';

export interface HubOptions {
  loaded: LoadedConfig;
  /** Directory for hub.sqlite, or `:memory:`. */
  dataDir: string;
  /** Null runs without NATS (tests, embedding): use `dispatch` and `ports`. */
  nats: NatsSettings | null;
  ports?: { delivery: DeliveryPort; events: EventPort };
  clock?: Clock;
  logger?: Logger;
}

export interface Hub {
  context: HubContext;
  /** The RPC entry point (what NATS requests are routed to). */
  dispatch: RpcDispatcher;
  services: HubServices;
  /** Runs every scheduled job once (tests drive time with this). */
  tick(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const OUTBOX_RETENTION_MS = 7 * DAY_MS;

/** Assembles the hub. With NATS settings it connects (waiting for the server) before returning. */
export async function createHub(options: HubOptions): Promise<Hub> {
  const { loaded } = options;
  const config = loaded.config;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger('hub');
  const db = new Db(
    options.dataDir === ':memory:' ? ':memory:' : join(options.dataDir, 'hub.sqlite'),
  );
  migrate(db, () => clock.now());

  const nats: HubNats | null = options.nats ? await connectHubNats(options.nats, logger) : null;
  const fallback = new MemoryPorts();
  const natsPorts = nats ? new NatsPorts(nats.js, config.mesh.prefix) : null;
  const delivery: DeliveryPort = natsPorts ?? options.ports?.delivery ?? fallback;
  const events: EventPort = natsPorts ?? options.ports?.events ?? fallback;
  const outbox = new SqliteOutbox(db, clock, logger, delivery, events);
  const context = createHubContext({
    loaded,
    index: new ConfigIndex(config),
    db,
    clock,
    logger,
    outbox,
  });

  const prefix = config.mesh.prefix;
  const transport = nats ? createNatsIngestTransport(nats.js, prefix, logger) : null;
  const inboxes = nats
    ? {
        ensure: (agentId: string) => ensureInboxConsumer(nats.jsm, prefix, agentId),
        remove: (agentId: string) => deleteInboxConsumer(nats.jsm, prefix, agentId),
      }
    : null;
  const built = buildModules(context, transport, inboxes);
  const idempotency = new IdempotencyStore(db, clock);
  const dispatch = createRpcRouter({
    index: () => context.index,
    handlers: built.handlers,
    idempotency,
    logger,
    onCall: (caller) => {
      if (caller.kind === 'agent') built.services.presence.touch(caller.id);
    },
  });

  const scheduler = new Scheduler(clock, logger, config.hub.tickSeconds * 1000);
  scheduler.add({ name: 'outbox.flush', run: () => outbox.flush() });
  scheduler.add({
    name: 'housekeeping',
    run: (now) => {
      outbox.prune(new Date(now.getTime() - OUTBOX_RETENTION_MS));
      idempotency.prune(new Date(now.getTime() - DAY_MS));
    },
  });
  for (const job of built.ticks) scheduler.add(job);

  const subscriptions: Subscription[] = [];
  return {
    context,
    dispatch,
    services: built.services,
    tick: () => scheduler.tick(),
    async start() {
      if (nats) {
        // The merged config, so enrolled members keep their inboxes across restarts.
        await provisionTopology(nats, context.index.config, logger);
        subscriptions.push(serveRpc(nats.nc, dispatch, { prefix: config.mesh.prefix, logger }));
        subscriptions.push(
          startPresenceListener(nats.nc, config.mesh.prefix, built.services.presence, logger),
        );
      }
      for (const module of built.modules) await module.start?.();
      scheduler.start();
      await outbox.flush();
    },
    async stop() {
      await scheduler.stop();
      for (const module of [...built.modules].reverse()) await module.stop?.();
      for (const sub of subscriptions) sub.unsubscribe();
      await outbox.flush().catch((err) => logger.warn({ err }, 'final outbox flush failed'));
      if (nats) await nats.nc.drain().catch(() => undefined);
      db.close();
    },
  };
}
