import type { Logger } from '@agentmesh/common';
import type { RpcResult } from '@agentmesh/protocol';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { PluginConfig } from './config';
import { HubClient } from './hub';
import { runSessionInbox } from './inbox/session-inbox';
import { Presence } from './presence';
import { pushEvent, VERSION } from './server';
import { ActivationCheck, checkEvent } from './tools/activation';

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
  activation: ActivationCheck;
  /** Runs once per hello that lands in a new session because the hub closed the previous one. */
  onRenewed: (() => void) | null;
}

/** Connects in the background and waits briefly for the hub's hello. */
export async function openSession(config: PluginConfig, logger: Logger): Promise<Session> {
  const hub = new HubClient(config, logger);
  const presence = new Presence(hub, logger, process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  hub.connect();
  await presence.refreshGit();
  let inFlight: Promise<Hello | null> | null = null;
  const session: Session = {
    config,
    hub,
    presence,
    hello: null,
    activation: new ActivationCheck(),
    onRenewed: null,
    sayHello: () => {
      inFlight ??= register(hub, presence, logger, () => session.onRenewed?.()).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
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
 */
export function startSession(
  server: Server,
  session: Session,
  logger: Logger,
  pushDelayMs: number,
): () => Promise<void> {
  const { hub, presence, hello } = session;
  const abort = new AbortController();
  let inbox: ReturnType<typeof runSessionInbox> | null = null;
  const rehello = () => void session.sayHello().then((h) => h && inbox?.resubscribe());
  hub.onSessionLost = rehello;
  // The hub closed the old session (a long sleep, say). The human opted this window in, so Claude
  // re-confirms through a fresh check instead of the session going quiet.
  session.onRenewed = () => {
    const previous = session.activation.lastDescription;
    if (previous === null) return;
    logger.info({ session: hub.sessionId }, 'new hub session; re-running the activation check');
    void pushEvent(server, checkEvent(session.activation.issue(), previous)).catch((err) =>
      logger.warn({ err }, 'could not push the activation check'),
    );
  };
  presence.start();
  // Without a session the hub delivers nothing, so keep asking until it answers.
  const retry = setInterval(() => !hub.sessionId && rehello(), hub.config.heartbeatSeconds * 1000);
  retry.unref();
  const startPushes = () => {
    inbox = runSessionInbox({
      hub,
      logger,
      signal: abort.signal,
      push: (event) => pushEvent(server, event),
      onExpired: rehello,
    });
    if (!hub.sessionId) {
      rehello();
    } else if (hello && hello.unreadThreads > 0) {
      void pushEvent(server, {
        content: `You have ${hello.unreadThreads} mesh thread(s) with unread messages. Call the inbox tool to catch up.`,
        meta: { kind: 'system', from: 'agentmesh' },
      }).catch(() => undefined);
    }
  };
  // ponytail: fixed delay, no ready signal exists; missed pushes still show up via inbox.
  setTimeout(startPushes, pushDelayMs).unref();
  return async () => {
    abort.abort();
    clearInterval(retry);
    hub.onSessionLost = null;
    session.onRenewed = null;
    presence.stop();
    await Promise.race([
      hub.call('session.bye', {}, { timeoutMs: SHUTDOWN_MS }).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS)),
    ]);
    await hub.close(SHUTDOWN_MS);
  };
}

/**
 * Registers with the hub, offering this process's current session so the hub
 * keeps it (or reclaims its work) after sleep or expiry. Null if it failed.
 * `onRenewed` runs when the hub answers with a new session instead.
 */
async function register(
  hub: HubClient,
  presence: Presence,
  logger: Logger,
  onRenewed: () => void,
): Promise<Hello | null> {
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
    if (previous && previous !== hello.sessionId) onRenewed();
    return hello;
  } catch (err) {
    logger.warn({ err }, 'session.hello failed');
    return null;
  }
}
