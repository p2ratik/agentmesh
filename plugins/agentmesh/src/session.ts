import type { Logger } from '@agentmesh/common';
import type { RpcResult } from '@agentmesh/protocol';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { PluginConfig } from './config';
import { HubClient } from './hub';
import { runInbox } from './inbox/consumer';
import { Presence } from './presence';
import { pushEvent, VERSION } from './server';

const HELLO_WAIT_MS = 4000;
const SHUTDOWN_MS = 250;

export interface Session {
  config: PluginConfig;
  hub: HubClient;
  presence: Presence;
  /** The hub's greeting, or null if it did not answer in time. */
  hello: RpcResult<'session.hello'> | null;
}

/** Connects in the background and waits briefly for the hub's hello. */
export async function openSession(config: PluginConfig, logger: Logger): Promise<Session> {
  const hub = new HubClient(config, logger);
  const presence = new Presence(hub, logger, process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  hub.connect();
  const git = await presence.refreshGit();
  const hello = await sayHello(hub, git, HELLO_WAIT_MS, logger);
  return { config, hub, presence, hello };
}

/**
 * Starts heartbeats and inbox pushes once Claude Code listens. Returns the
 * shutdown routine. `pushDelayMs` covers the gap after the MCP handshake in
 * which Claude Code silently drops channel notifications.
 */
export function startSession(
  server: Server,
  session: Session,
  logger: Logger,
  pushDelayMs: number,
): () => Promise<void> {
  const { hub, presence, hello } = session;
  const abort = new AbortController();
  presence.start();
  const startPushes = () => {
    void runInbox({ hub, logger, signal: abort.signal, push: (event) => pushEvent(server, event) });
    if (!hello) {
      void hub.whenConnected().then(() => sayHello(hub, presence.git, 10_000, logger));
    } else if (hello.unreadThreads > 0) {
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
    presence.stop();
    await Promise.race([
      hub.call('session.bye', {}, { timeoutMs: SHUTDOWN_MS }).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS)),
    ]);
    await hub.close(SHUTDOWN_MS);
  };
}

/** Registers with the hub; resolves null if it does not answer in time. */
async function sayHello(
  hub: HubClient,
  git: { repo?: string; branch?: string },
  waitMs: number,
  logger: Logger,
): Promise<RpcResult<'session.hello'> | null> {
  const attempt = hub
    .whenConnected()
    .then(() => hub.call('session.hello', { clientVersion: VERSION, ...git }))
    .catch((err) => {
      logger.warn({ err }, 'session.hello failed');
      return null;
    });
  return Promise.race([
    attempt,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
  ]);
}
