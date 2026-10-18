import { createLogger, type Logger } from '@agentmesh/common';
import type { RpcResult } from '@agentmesh/protocol';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type PluginConfig, resolveConfig } from './config';
import { HubClient } from './hub';
import { runInbox } from './inbox/consumer';
import { buildInstructions } from './instructions';
import { Presence } from './presence';
import { createMcpServer, pushEvent, VERSION } from './server';

const HELLO_WAIT_MS = 4000;
const SHUTDOWN_MS = 250;
const CHANNEL_READY_MS = 2000;

/**
 * Entry point Claude Code spawns over stdio. Never blocks startup on the
 * network: the MCP handshake completes even when the hub is unreachable.
 * stdout belongs to MCP, so every log line goes to stderr or a file.
 */
async function main(): Promise<void> {
  const resolved = resolveConfig();
  const config = resolved.ok ? resolved.config : null;
  const logger = createLogger('agentmesh-plugin', {
    destination: config?.logFile ? { file: config.logFile } : 'stderr',
  });
  if (!config) {
    const problems = resolved.ok ? [] : resolved.problems;
    logger.warn({ problems }, 'plugin is not configured');
    const server = createMcpServer(buildInstructions({ agentId: null, hello: null, problems }), {
      problems,
    });
    await server.connect(new StdioServerTransport());
    watchLifecycle(async () => undefined, logger);
    return;
  }
  await run(config, logger);
}

async function run(config: PluginConfig, logger: Logger): Promise<void> {
  const hub = new HubClient(config, logger);
  const presence = new Presence(hub, logger, process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  hub.connect();
  const git = await presence.refreshGit();
  const hello = await sayHello(hub, git, HELLO_WAIT_MS, logger);

  const server = createMcpServer(
    buildInstructions({ agentId: config.agentId, hello, problems: [] }),
    {
      hub,
      agentId: config.agentId,
    },
  );
  const abort = new AbortController();
  server.oninitialized = () => {
    presence.start();
    // Claude Code subscribes to channel notifications just after the handshake and silently
    // drops earlier ones, so queued messages would be acked into the void at startup.
    // ponytail: fixed delay, no ready signal exists; missed pushes still show up via inbox.
    setTimeout(() => startPushes(), CHANNEL_READY_MS).unref();
  };
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
  await server.connect(new StdioServerTransport());
  logger.info({ agent: config.agentId, version: VERSION }, 'agentmesh plugin ready');

  watchLifecycle(async () => {
    abort.abort();
    presence.stop();
    await Promise.race([
      hub.call('session.bye', {}, { timeoutMs: SHUTDOWN_MS }).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS)),
    ]);
    await hub.close(SHUTDOWN_MS);
  }, logger);
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

/** Exits when Claude Code closes stdin, on signals, or if orphaned. */
function watchLifecycle(cleanup: () => Promise<void>, logger: Logger): void {
  let stopping = false;
  const shutdown = (reason: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, 'agentmesh plugin stopping');
    void cleanup().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.stdin.on('end', () => shutdown('stdin end'));
  process.stdin.on('close', () => shutdown('stdin close'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  setInterval(() => {
    if (process.stdin.destroyed || process.stdin.readableEnded) shutdown('orphaned');
  }, 5000).unref();
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

main().catch((err) => {
  process.stderr.write(
    `agentmesh plugin failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
