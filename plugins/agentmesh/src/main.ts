import { createLogger, type Logger } from '@agentmesh/common';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type PluginConfig, resolveConfig } from './config';
import { buildInstructions } from './instructions';
import { runJoinCli } from './join/cli';
import { callJoinTool, JOIN_TOOL, joinToolListing } from './join/tool';
import { createMcpServer, type ToolHandler, VERSION } from './server';
import { openSession, type Session, startSession } from './session';
import { meshToolHandler } from './tools/registry';
import type { ToolDeps } from './tools/types';

const CHANNEL_READY_MS = 2000;

/** What to run when Claude Code closes the session; replaced once a session starts. */
let cleanup: () => Promise<void> = async () => undefined;

/**
 * Entry point Claude Code spawns over stdio. Never blocks startup on the
 * network: the MCP handshake completes even when the hub is unreachable.
 * stdout belongs to MCP, so every log line goes to stderr or a file.
 * `server.js join` is the terminal path for invites instead.
 */
async function main(): Promise<void> {
  if (process.argv[2] === 'join') {
    process.exit(await runJoinCli(process.argv.slice(3), VERSION));
  }
  const resolved = resolveConfig();
  const logFile = resolved.ok ? resolved.config.logFile : resolved.logFile;
  const logger = createLogger('agentmesh-plugin', {
    destination: logFile ? { file: logFile } : 'stderr',
  });
  watchLifecycle(logger);
  if (resolved.ok) {
    for (const warning of resolved.warnings ?? []) logger.warn(warning);
    return runConfigured(resolved.config, logger);
  }
  if (resolved.unenrolled) return runUnenrolled(logger);
  logger.warn({ problems: resolved.problems }, 'plugin is not configured');
  const { problems } = resolved;
  const server = createMcpServer(buildInstructions({ agentId: null, hello: null, problems }), () =>
    meshToolHandler({ problems }),
  );
  await server.connect(new StdioServerTransport());
}

async function runConfigured(config: PluginConfig, logger: Logger): Promise<void> {
  const session = await openSession(config, logger);
  const instructions = buildInstructions({
    agentId: config.agentId,
    hello: session.hello,
    problems: [],
  });
  const server = createMcpServer(instructions, () => handler);
  const handler = meshToolHandler(toolDeps(session, config.agentId));
  // Claude Code subscribes to channel notifications just after the handshake and silently
  // drops earlier ones, so queued messages would be acked into the void at startup.
  server.oninitialized = () => {
    cleanup = startSession(server, session, logger, CHANNEL_READY_MS);
  };
  await server.connect(new StdioServerTransport());
  logger.info({ agent: config.agentId, version: VERSION }, 'agentmesh plugin ready');
}

/**
 * No mesh configured yet: offer only `join`. Once it succeeds the same
 * session connects, swaps in the mesh tools and tells Claude Code they changed.
 */
async function runUnenrolled(logger: Logger): Promise<void> {
  const notJoined: ToolHandler = {
    list: () => [joinToolListing],
    call: async (name, args) =>
      name === JOIN_TOOL
        ? callJoinTool(args, { clientVersion: VERSION, onJoined })
        : {
            content: [{ type: 'text', text: 'This laptop has not joined a mesh yet; use join.' }],
            isError: true,
          },
  };
  let handler = notJoined;
  const instructions = buildInstructions({
    agentId: null,
    hello: null,
    problems: [],
    unenrolled: true,
  });
  const server = createMcpServer(instructions, () => handler);

  async function onJoined(agentId: string): Promise<void> {
    const resolved = resolveConfig();
    if (!resolved.ok)
      throw new Error(
        `joined, but the saved settings do not load: ${resolved.problems.join('; ')}`,
      );
    for (const warning of resolved.warnings ?? []) logger.warn(warning);
    const session = await openSession(resolved.config, logger);
    handler = meshToolHandler(toolDeps(session, agentId));
    cleanup = startSession(server, session, logger, 0);
    await server.sendToolListChanged().catch(() => undefined);
    logger.info({ agent: agentId, version: VERSION }, 'joined the mesh');
  }

  await server.connect(new StdioServerTransport());
  logger.info({ version: VERSION }, 'agentmesh plugin waiting for join');
}

function toolDeps(session: Session, agentId: string): ToolDeps {
  return { hub: session.hub, agentId, activation: session.activation, fyi: session.fyi };
}

/** Exits when Claude Code closes stdin, on signals, or if orphaned. */
function watchLifecycle(logger: Logger): void {
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
