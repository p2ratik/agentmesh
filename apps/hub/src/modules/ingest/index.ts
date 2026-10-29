import type { Server } from 'node:http';
import type { HubContext } from '../../context';
import type {
  HubModule,
  IngestService,
  MessagingService,
  PresenceService,
  TaskService,
} from '../../contracts';
import { closeServer, startIngestServer } from './http/server';
import { IngestServiceImpl } from './ingest.service';
import type { IngestTransport } from './transport';

export { createNatsIngestTransport, type IngestTransport } from './transport';

export interface IngestDeps {
  messaging: MessagingService;
  tasks: TaskService;
  presence: PresenceService;
  /** Null runs the rules directly from HTTP (tests, single-process setups). */
  transport: IngestTransport | null;
}

/** External events: HTTP + NATS ingestion, dedup, and the rules engine. */
export function createIngestModule(ctx: HubContext, deps: IngestDeps): HubModule<IngestService> {
  const service = new IngestServiceImpl(ctx, {
    messaging: deps.messaging,
    tasks: deps.tasks,
    presence: deps.presence,
  });
  let server: Server | null = null;
  let consuming: AbortController | null = null;
  return {
    service,
    handlers: {},
    ticks: [{ name: 'ingest.prune', run: (now) => service.prune(now) }],
    async start() {
      const { hub, ingest } = ctx.index.config;
      const { transport } = deps;
      if (hub.http.enabled) {
        server = await startIngestServer({
          host: hub.http.host,
          port: hub.http.port,
          sources: ingest.sources,
          logger: ctx.logger,
          sink: async (source, event) => {
            if (!transport) return service.accept(source, event);
            await transport.publish(source, event);
            return { duplicate: false };
          },
        });
      }
      if (transport) {
        consuming = new AbortController();
        void transport.run(async (source, event) => {
          await service.accept(source, event);
        }, consuming.signal);
      }
    },
    async stop() {
      consuming?.abort();
      await closeServer(server);
      server = null;
    },
  };
}
