import { type CallOptions, connectBus, type NatsConnection, RpcClient } from '@agentmesh/bus';
import { type Logger, MeshError } from '@agentmesh/common';
import {
  inboxPrefix,
  type RpcMethodName,
  type RpcParamsInput,
  type RpcResult,
} from '@agentmesh/protocol';
import type { PluginConfig } from './config';

export const UNREACHABLE =
  'The mesh hub is unreachable right now; nothing was sent. Try again shortly.';

/** How the hub's `not_found` starts when it no longer knows the session a call carried. */
const UNKNOWN_SESSION = 'Unknown or closed session';

/**
 * The plugin's connection to the hub. Connecting happens in the background
 * and retries forever (laptops wake before Wi-Fi does), through refused
 * connects too (`connectBus`); calls made before it is up fail fast with
 * `unavailable` instead of hanging Claude's tool call. Other permanent closes
 * (a protocol `-ERR`) still end the connection until the session restarts.
 */
export class HubClient {
  readonly config: PluginConfig;
  /** This process's hub session (from `session.hello`); in memory only, never shared. */
  sessionId: string | null = null;
  /** Called when a call fails because the hub no longer knows `sessionId`. */
  onSessionLost: (() => void) | null = null;
  readonly #logger: Logger;
  #nc: NatsConnection | null = null;
  #rpc: RpcClient | null = null;
  #notes: string[] = [];
  readonly #ready: Promise<NatsConnection>;
  #resolveReady: (nc: NatsConnection) => void = () => undefined;

  constructor(config: PluginConfig, logger: Logger) {
    this.config = config;
    this.#logger = logger;
    this.#ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  connect(): void {
    connectBus({
      servers: this.config.servers,
      name: `agentmesh-plugin:${this.config.agentId}`,
      inboxPrefix: inboxPrefix(this.config.agentId),
      ...(this.config.nkeySeed ? { credentials: { nkeySeed: this.config.nkeySeed } } : {}),
      logger: this.#logger,
    })
      .then((nc) => {
        this.#nc = nc;
        this.#rpc = new RpcClient(nc, this.config.prefix, this.config.agentId);
        this.#logger.info({ server: nc.getServer() }, 'connected to the mesh');
        this.#resolveReady(nc);
      })
      .catch((err) => this.#logger.error({ err }, 'could not connect to the mesh'));
  }

  whenConnected(): Promise<NatsConnection> {
    return this.#ready;
  }

  get connection(): NatsConnection | null {
    return this.#nc;
  }

  async call<M extends RpcMethodName>(
    method: M,
    params: RpcParamsInput<M>,
    options: CallOptions = {},
  ): Promise<RpcResult<M>> {
    if (!this.#rpc) throw new MeshError('unavailable', UNREACHABLE);
    const session = this.sessionId;
    try {
      const { result, notes } = await this.#rpc.callWithNotes(method, params, {
        ...(session ? { session } : {}),
        ...options,
      });
      this.#notes.push(...notes);
      return result;
    } catch (err) {
      if (session && err instanceof MeshError && err.message.startsWith(UNKNOWN_SESSION)) {
        this.onSessionLost?.();
      }
      throw err;
    }
  }

  /** The hub's notes from calls since the last take. */
  takeNotes(): string[] {
    return this.#notes.splice(0);
  }

  /** Best effort within `timeoutMs` (Windows kills the process ~300ms after stdin closes). */
  async close(timeoutMs: number): Promise<void> {
    const nc = this.#nc;
    if (!nc) return;
    await Promise.race([
      nc.drain().catch(() => undefined),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}
