import { readFileSync } from 'node:fs';
import { expandHome, type Logger } from '@agentmesh/common';
import {
  type Authenticator,
  type ConnectionOptions,
  connect,
  type NatsConnection,
  nkeyAuthenticator,
  nkeys,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
} from '@nats-io/transport-node';

export type { NatsConnection } from '@nats-io/transport-node';

/**
 * One credential kind; nkey seeds are the recommended default. An nkey may
 * carry a token in the same CONNECT: that is how an invite is redeemed.
 */
export interface BusCredentials {
  /** An nkey seed (`SU…`) or a path to a file containing one. */
  nkeySeed?: string;
  user?: string;
  pass?: string;
  token?: string;
}

export interface ConnectBusOptions {
  servers: string[];
  /** Shown in NATS monitoring; use the participant or service id. */
  name: string;
  credentials?: BusCredentials;
  /** Lets NATS permissions scope reply subjects to this client. */
  inboxPrefix?: string;
  logger?: Logger;
}

const SEED_PATTERN = /^SU[A-Z2-7]{56}$/;

/** Accepts a literal seed or a path to a seed file (`~/…` allowed). */
export function resolveSeed(seedOrPath: string): string {
  const value = seedOrPath.trim();
  if (SEED_PATTERN.test(value)) return value;
  const fromFile = readFileSync(expandHome(value), 'utf8').trim();
  if (!SEED_PATTERN.test(fromFile))
    throw new Error(`File ${value} does not contain an nkey user seed`);
  return fromFile;
}

/** A fresh user nkey, generated locally; only the public key ever leaves this machine. */
export function generateUserKey(): { seed: string; publicKey: string } {
  const user = nkeys.createUser();
  return { seed: new TextDecoder().decode(user.getSeed()), publicKey: user.getPublicKey() };
}

function authenticator(
  credentials: BusCredentials | undefined,
): Authenticator | Authenticator[] | undefined {
  if (!credentials) return undefined;
  if (credentials.nkeySeed) {
    const seed = new TextEncoder().encode(resolveSeed(credentials.nkeySeed));
    const nkey = nkeyAuthenticator(seed);
    return credentials.token ? [nkey, tokenAuthenticator(credentials.token)] : nkey;
  }
  if (credentials.token) return tokenAuthenticator(credentials.token);
  if (credentials.user) return usernamePasswordAuthenticator(credentials.user, credentials.pass);
  return undefined;
}

/**
 * nats.js drops the URL scheme and upgrades to TLS only when the server's
 * INFO offers it, which anyone in the path can strip. `tls: {}` makes the
 * client refuse a server that does not offer TLS, so a `tls://` URL means
 * what it says.
 */
export function requiresTls(servers: readonly string[]): boolean {
  return servers.some((s) => /^(tls|wss):\/\//i.test(s.trim()));
}

function baseOptions(options: ConnectBusOptions): ConnectionOptions {
  const auth = authenticator(options.credentials);
  return {
    servers: options.servers,
    name: options.name,
    ...(auth ? { authenticator: auth } : {}),
    ...(options.inboxPrefix ? { inboxPrefix: options.inboxPrefix } : {}),
    ...(requiresTls(options.servers) ? { tls: {} } : {}),
  };
}

/**
 * Connects with settings suited to long-lived processes on flaky networks:
 * unlimited reconnects, and the first connect waits for the server instead
 * of failing fast (laptops wake up before Wi-Fi does). Refused reconnects
 * keep retrying too: under the auth callout, NATS refuses everyone while the
 * hub restarts, and nats.js would otherwise give up after two in a row.
 */
export async function connectBus(options: ConnectBusOptions): Promise<NatsConnection> {
  const nc = await connect({
    ...baseOptions(options),
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2_000,
    waitOnFirstConnect: true,
    ignoreAuthErrorAbort: true,
  });
  if (options.logger) watchStatus(nc, options.logger);
  return nc;
}

/** One attempt, no reconnects: for a join, where a refusal must surface at once. */
export function connectOnce(
  options: ConnectBusOptions,
  timeoutMs = 5_000,
): Promise<NatsConnection> {
  return connect({ ...baseOptions(options), reconnect: false, timeout: timeoutMs });
}

function watchStatus(nc: NatsConnection, logger: Logger): void {
  void (async () => {
    for await (const status of nc.status()) {
      if (status.type === 'disconnect' || status.type === 'reconnect') {
        logger.info({ nats: status.type, server: nc.getServer() }, `nats ${status.type}`);
      } else if (status.type === 'error') {
        logger.warn({ nats: status.type, err: status.error }, 'nats error');
      }
    }
  })();
  void nc.closed().then((err) => {
    if (err) logger.error({ err }, 'nats connection closed with error');
  });
}

/**
 * Credentials from the standard environment variables shared by every
 * AgentMesh process: AGENTMESH_NKEY_SEED (seed or file path), or
 * AGENTMESH_NATS_TOKEN, or AGENTMESH_NATS_USER / AGENTMESH_NATS_PASS.
 */
export function credentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): BusCredentials | undefined {
  if (env.AGENTMESH_NKEY_SEED) return { nkeySeed: env.AGENTMESH_NKEY_SEED };
  if (env.AGENTMESH_NATS_TOKEN) return { token: env.AGENTMESH_NATS_TOKEN };
  if (env.AGENTMESH_NATS_USER) {
    return {
      user: env.AGENTMESH_NATS_USER,
      ...(env.AGENTMESH_NATS_PASS ? { pass: env.AGENTMESH_NATS_PASS } : {}),
    };
  }
  return undefined;
}

/** NATS servers: AGENTMESH_NATS_URL (comma-separated) overrides the configured list. */
export function serversFromEnv(
  configured: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const fromEnv = env.AGENTMESH_NATS_URL?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv?.length ? fromEnv : [...configured];
}
