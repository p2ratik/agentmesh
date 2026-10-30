import { homedir } from 'node:os';
import type { Logger } from '@agentmesh/common';
import type { RpcResult } from '@agentmesh/protocol';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { PluginConfig } from './config';
import { HubClient } from './hub';
import { FyiBuffer } from './inbox/fyi';
import { runSessionInbox } from './inbox/session-inbox';
import { Presence } from './presence';
import { pullStateDirs } from './pull/state';
import { PullWatcher } from './pull/watcher';
import { pushEvent, VERSION } from './server';
import { type ActivationState, checkEvent, newActivationState } from './tools/activation';

const HELLO_WAIT_MS = 4000;
const SHUTDOWN_MS = 250;

type Hello = RpcResult<'session.hello'>;

export interface Session {
  config: PluginConfig;
  hub: HubClient;
  presence: Presence;
  /** The hub's greeting, or null if it did not answer in time. */
  hello: Hello | null;
  /** Says hello (again), one call at a time; resolves null if it failed. */
  sayHello(): Promise<Hello | null>;
  activation: ActivationState;
  /** Status items waiting to ride along (on tool results and action pushes). */
  fyi: FyiBuffer;
  /** Runs after each hello that lands; `renewed` when the hub replaced the previous session. */
  onHello: ((renewed: boolean) => void) | null;
  /** Resolved once the inbox first listens on the session subject (the hub's check goes there). */
  listening: PromiseWithResolvers<void>;
  /** Keeps the prompt hook's state file current while this session is active in pull mode. */
  pull: PullWatcher;
}

/** Connects in the background and waits briefly for the hub's hello. */
export async function openSession(config: PluginConfig, logger: Logger): Promise<Session> {
  const hub = new HubClient(config, logger);
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const presence = new Presence(hub, logger, projectDir);
  const activation = newActivationState();
  hub.connect();
  await presence.refreshGit();
  let inFlight: Promise<Hello | null> | null = null;
  const session: Session = {
    config,
    hub,
    presence,
    hello: null,
    activation,
    fyi: new FyiBuffer(),
    onHello: null,
    listening: Promise.withResolvers(),
    pull: new PullWatcher({
      hub,
      activation,
      agentId: config.agentId,
      prefix: config.prefix,
      dir: pullStateDirs(process.env, homedir())[0] ?? '.',
      projectDir,
      logger,
    }),
    sayHello: () => {
      inFlight ??= register(hub, presence, logger)
        .then((landed) => {
          if (landed) session.onHello?.(landed.renewed);
          return landed?.hello ?? null;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
  // A call without a session says hello first (or waits for this one): the hub refuses it otherwise.
  hub.sayHello = session.sayHello;
  // The handshake must not wait on the network; a late hello still sets `hub.sessionId`.
  session.hello = await Promise.race([
    session.sayHello(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), HELLO_WAIT_MS)),
  ]);
  return session;
}

/**
 * Starts heartbeats and inbox pushes once Claude Code listens. Returns the
 * shutdown routine. `pushDelayMs` covers the gap after the MCP handshake in
 * which Claude Code silently drops channel notifications, so the session
 * subject is not subscribed (and nothing acked into the void) before then.
 * Nothing is pushed at startup: a new session is inactive until its human
 * activates it.
 */
export function startSession(
  server: Server,
  session: Session,
  logger: Logger,
  pushDelayMs: number,
): () => Promise<void> {
  const { hub, presence } = session;
  const abort = new AbortController();
  let inbox: ReturnType<typeof runSessionInbox> | null = null;
  const rehello = () => void session.sayHello();
  hub.onSessionLost = rehello;
  session.onHello = (renewed) => {
    inbox?.resubscribe();
    if (renewed) recheck(session, logger);
  };
  presence.start();
  session.pull.start();
  // Without a session the hub delivers nothing, so keep asking until it answers; a refused
  // subscription (NATS permissions, say) is retried on the same beat.
  const retry = setInterval(
    () => (hub.sessionId ? inbox?.retryFailed() : rehello()),
    hub.config.heartbeatSeconds * 1000,
  );
  retry.unref();
  const startPushes = () => {
    inbox = runSessionInbox({
      hub,
      logger,
      signal: abort.signal,
      fyi: session.fyi,
      push: (event) => pushEvent(server, event),
      pushCheck: (code) =>
        pushEvent(server, checkEvent(code, session.activation.renewedFrom ?? undefined)),
      onExpired: rehello,
      onListening: () => {
        presence.beat();
        session.listening.resolve();
      },
    });
    if (!hub.sessionId) rehello();
  };
  // ponytail: fixed delay, no ready signal exists; missed pushes still show up via inbox.
  setTimeout(startPushes, pushDelayMs).unref();
  return async () => {
    session.pull.stop();
    abort.abort();
    clearInterval(retry);
    hub.onSessionLost = null;
    session.onHello = null;
    presence.stop();
    // Without a session there is nothing to close, and the call would open one.
    if (hub.sessionId) {
      await Promise.race([
        hub.call('session.bye', {}, { timeoutMs: SHUTDOWN_MS }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS)),
      ]);
    }
    await hub.close(SHUTDOWN_MS);
  };
}

/**
 * The hub closed this window's active session (a long sleep, say) and gave it a
 * new, inactive one. The human opted this window in, so Claude re-confirms
 * through a fresh check (sent by the hub) that suggests the previous line. A
 * pull session gets no check to answer, so it re-activates in pull mode at once.
 */
function recheck(session: Session, logger: Logger): void {
  const { activation, hub } = session;
  if (activation.lastDescription === null) return;
  if (activation.pull) {
    logger.info({ session: hub.sessionId }, 'new hub session; re-activating it in pull mode');
    void hub
      .call('session.activate', { mode: 'pull', description: activation.lastDescription })
      .then(() => session.pull.refresh())
      .catch((err) => logger.warn({ err }, 'could not re-activate the pull session'));
    return;
  }
  activation.renewedFrom = activation.lastDescription;
  logger.info({ session: hub.sessionId }, 'new hub session; re-running the activation check');
  void hub
    .call('session.check', {})
    .catch((err) => logger.warn({ err }, 'could not start the activation check'));
}

/**
 * Registers with the hub, offering this process's current session so the hub
 * keeps it (or reclaims its work) after sleep or expiry. Null if it failed;
 * `renewed` when the hub answered with a new session instead.
 */
async function register(
  hub: HubClient,
  presence: Presence,
  logger: Logger,
): Promise<{ hello: Hello; renewed: boolean } | null> {
  try {
    await hub.whenConnected();
    const previous = hub.sessionId;
    const hello = await hub.call('session.hello', {
      clientVersion: VERSION,
      ...presence.git,
      ...(previous ? { previousSessionId: previous } : {}),
    });
    hub.sessionId = hello.sessionId;
    logger.info({ session: hello.sessionId, previous, reclaimed: hello.reclaimed }, 'hub session');
    return { hello, renewed: previous !== null && previous !== hello.sessionId };
  } catch (err) {
    logger.warn({ err }, 'session.hello failed');
    return null;
  }
}
