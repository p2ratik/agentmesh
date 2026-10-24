import { join } from 'node:path';
import { connectBus, type RpcDispatcher, serveRpc } from '@agentmesh/bus';
import { type Clock, createLogger, DAY_MS, type Logger, systemClock } from '@agentmesh/common';
import { ConfigIndex, type LoadedConfig } from '@agentmesh/config';
import { createHubContext, type HubContext } from './context';
import { NatsPorts } from './core/nats-ports';
import { SqliteOutbox } from './core/outbox';
import { Db } from './db/database';
import { migrate } from './db/migrate';
import { CalloutService, type LoadedCalloutKeys } from './modules/callout';
import { createNatsIngestTransport } from './modules/ingest';
import { type Subscription, startPresenceListener } from './modules/presence';
import { SessionDispatcher } from './modules/sessions/dispatcher';
import { NatsSessionTransport } from './modules/sessions/nats-transport';
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
  /** Auth-callout mode: the hub admits agents itself (see `loadCalloutKeys`). Needs `nats`. */
  callout?: LoadedCalloutKeys | null;
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

/** What the modules need from NATS: none of it exists without a connection. */
async function natsAdapters(nats: HubNats | null, options: HubOptions, logger: Logger) {
  if (!nats) return { transport: null, sessionTransport: null, sys: null };
  const prefix = options.loaded.config.mesh.prefix;
  // Auth-callout mode: a second connection as the hub's kick-only system-account user.
  const sys = options.callout
    ? await connectBus({
        servers: options.nats?.servers ?? [],
        name: 'agentmesh-hub-sys',
        credentials: { nkeySeed: options.callout.sysSeed },
        logger,
      })
    : null;
  return {
    transport: createNatsIngestTransport(nats.js, prefix, logger),
    sessionTransport: new NatsSessionTransport(nats.nc, prefix, logger),
    sys,
  };
}

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
  // With NATS, deliveries go to sessions through the dispatcher, built once the modules exist.
  let dispatcher: SessionDispatcher | null = null;
  const toSessions: DeliveryPort = {
    deliver: (recipientId, messages) => {
      if (!dispatcher) throw new Error('session dispatcher not built yet');
      return dispatcher.deliver(recipientId, messages);
    },
  };
  const delivery: DeliveryPort = nats ? toSessions : (options.ports?.delivery ?? fallback);
  const events: EventPort = nats
    ? new NatsPorts(nats.js, config.mesh.prefix)
    : (options.ports?.events ?? fallback);
  const outbox = new SqliteOutbox(db, clock, logger, delivery, events);
  const context = createHubContext({
    loaded,
    index: new ConfigIndex(config),
    db,
    clock,
    logger,
    outbox,
  });

  const { transport, sessionTransport, sys } = await natsAdapters(nats, options, logger);
  let callout: CalloutService | null = null;
  const kick = (agentId: string) => callout?.kick(agentId) ?? Promise.resolve();
  const built = buildModules(context, transport, { kick: sys ? kick : null, sessionTransport });
  if (sessionTransport) {
    const { sessions, messaging } = built.services;
    dispatcher = new SessionDispatcher({
      sessions,
      messaging,
      transport: sessionTransport,
      logger,
    });
  }
  if (sys && options.callout) {
    const { enrollment } = built.services;
    callout = new CalloutService(context, { keys: options.callout, enrollment, sys });
  }
  const idempotency = new IdempotencyStore(db, clock);
  const dispatch = createRpcRouter({
    index: () => context.index,
    handlers: built.handlers,
    idempotency,
    logger,
    sessions: built.services.sessions,
    transaction: (fn) => db.transaction(fn),
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
        await provisionTopology(nats, config, logger);
        if (callout) subscriptions.push(callout.start(nats.nc));
        subscriptions.push(serveRpc(nats.nc, dispatch, { prefix: config.mesh.prefix, logger }));
        subscriptions.push(
          startPresenceListener(
            nats.nc,
            config.mesh.prefix,
            built.services.presence,
            () => context.index,
            logger,
            (agent, session, git) => built.services.sessions.touch(agent, session, git),
            // A closed or unknown session's plugin says hello again.
            (agent, session) => sessionTransport?.expired(agent, session),
          ),
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
      if (sys) await sys.drain().catch(() => undefined);
      if (nats) await nats.nc.drain().catch(() => undefined);
      db.close();
    },
  };
}
