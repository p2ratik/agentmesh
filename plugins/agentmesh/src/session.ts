import { homedir, platform } from 'node:os';
import type { Logger } from '@agentmesh/common';
import { CLOSED_ASKER_DEFAULT_MINUTES, type RpcResult } from '@agentmesh/protocol';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { PluginConfig } from './config';
import { HubClient } from './hub';
import { FyiBuffer } from './inbox/fyi';
import { runSessionInbox } from './inbox/session-inbox';
import { Presence } from './presence';
import { PullWatcher } from './pull/watcher';
import { ownAddress } from './relay/address';
import { forwardRelay } from './relay/window-relay';
import { readClaudeSession } from './resume/claude-session';
import { byeQuietly, followEvery, noteReclaimed, SHUTDOWN_MS } from './resume/conversation';
import { pushEvent, VERSION } from './server';
import { type ActivationState, checkEvent, newActivationState } from './tools/activation';
import { type MeshWindowContext, meshWindowContext } from './window/context';

const HELLO_WAIT_MS = 4000;

type Hello = RpcResult<'session.hello'>;

export interface Session {
  config: PluginConfig;
  hub: HubClient;
  presence: Presence;
  /** The hub's greeting, or null if it did not answer in time. */
  hello: Hello | null;
  /** Whether this process is the user's mesh window; hello reports it to the hub. */
  window: MeshWindowContext;
  /** Says hello (again), one call at a time; resolves null if it failed. */
  sayHello(): Promise<Hello | null>;
  activation: ActivationState;
  /** Status items waiting to ride along (on tool results and action pushes). */
  fyi: FyiBuffer;
  /** Runs after each hello that lands; `renewed` when the hub replaced the previous session. */
  onHello: ((renewed: boolean) => void) | null;
  /** Resolved once the inbox first listens on the session subject (the hub's check goes there). */
  listening: PromiseWithResolvers<void>;
  /** Keeps the hooks' local file current: pull counts, heartbeat or private record. */
  pull: PullWatcher;
  /** This session's messaging address: local data, never logged or sent to the hub. */
  uds: string | null;
  /** When this server started; an older conversation record belongs to a dead process. */
  startedAt: number;
  /** Claude Code's conversation, from the SessionStart record; every hello reports it. */
  claudeSessionId: string | null;
  /** Lines that end the next tool result: threads the hub gave back to this session. */
  notices: string[];
}

/** Connects in the background and waits briefly for the hub's hello. */
export async function openSession(config: PluginConfig, logger: Logger): Promise<Session> {
  const startedAt = Date.now();
  const hub = new HubClient(config, logger);
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const presence = new Presence(hub, logger, projectDir);
  const activation = newActivationState();
  const window = meshWindowContext(process.env, homedir(), platform(), projectDir, config.agentId);
  const uds = ownAddress(process.env.CLAUDE_CODE_MESSAGING_SOCKET);
  hub.connect();
  await presence.refreshGit();
  let inFlight: Promise<Hello | null> | null = null;
  const session: Session = {
    config,
    hub,
    presence,
    hello: null,
    window,
    activation,
    fyi: new FyiBuffer(),
    onHello: null,
    listening: Promise.withResolvers(),
    pull: new PullWatcher({
      hub,
      activation,
      agentId: config.agentId,
      prefix: config.prefix,
      dir: window.dataDir,
      projectDir,
      meshWindow: window.state === 'verified',
      marked: window.state !== 'none',
      uds,
      claudePid: process.ppid,
      claudeSessionId: () => session.claudeSessionId,
      relay: process.env.AGENTMESH_RELAY !== 'off',
      logger,
    }),
    uds,
    startedAt,
    claudeSessionId: readClaudeSession(window.dataDir, process.ppid, startedAt),
    notices: [],
    sayHello: () => {
      inFlight ??= register(session, logger)
        .then((landed) => {
          if (landed) noteReclaimed(session, landed.hello.reclaimed);
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
  const stopFollowing = followEvery(session, () =>
    readClaudeSession(session.window.dataDir, process.ppid, session.startedAt),
  );
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
      onRelay: (relay) =>
        forwardRelay(relay, {
          window: session.window,
          agentId: session.config.agentId,
          prefix: session.config.prefix,
          ownUds: session.uds,
          ownSession: hub.sessionId,
          guardVersion: session.activation.guardVersion,
          platform: process.platform,
          now: Date.now(),
          push: (event) => pushEvent(server, event),
          logger,
        }),
      closedAskerMinutes: () =>
        session.hello?.policy.closedAskerEscalationMinutes ?? CLOSED_ASKER_DEFAULT_MINUTES,
    });
    if (!hub.sessionId) rehello();
  };
  // ponytail: fixed delay, no ready signal exists; missed pushes still show up via inbox.
  setTimeout(startPushes, pushDelayMs).unref();
  return async () => {
    stopFollowing();
    session.pull.stop();
    abort.abort();
    clearInterval(retry);
    hub.onSessionLost = null;
    session.onHello = null;
    presence.stop();
    await byeQuietly(hub);
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
  void session.pull.refresh();
  logger.info({ session: hub.sessionId }, 'new hub session; re-running the activation check');
  void hub
    .call('session.check', {})
    .catch((err) => logger.warn({ err }, 'could not start the activation check'));
}

/**
 * Registers with the hub, offering this process's current session (so the hub keeps it, or
 * reclaims its work, after sleep or expiry) and its conversation once connected. Null if it
 * failed; `renewed` when the hub answered with a new session instead.
 */
async function register(
  session: Pick<Session, 'hub' | 'presence' | 'window' | 'claudeSessionId'>,
  logger: Logger,
): Promise<{ hello: Hello; renewed: boolean } | null> {
  const { hub, presence } = session;
  try {
    await hub.whenConnected();
    const previous = hub.sessionId;
    const { claudeSessionId } = session;
    const hello = await hub.call('session.hello', {
      clientVersion: VERSION,
      ...presence.git,
      ...(session.window.state === 'verified' ? { meshWindow: true } : {}),
      ...(previous ? { previousSessionId: previous } : {}),
      ...(claudeSessionId ? { claudeSessionId } : {}),
    });
    hub.sessionId = hello.sessionId;
    logger.info({ session: hello.sessionId, previous, reclaimed: hello.reclaimed }, 'hub session');
    return { hello, renewed: previous !== null && previous !== hello.sessionId };
  } catch (err) {
    logger.warn({ err }, 'session.hello failed');
    return null;
  }
}
