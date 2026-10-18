import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ChannelEvent } from './inbox/render';
import { callTool, listTools } from './tools/registry';
import type { ToolDeps } from './tools/types';

export const SERVER_NAME = 'mesh';
export const VERSION = '0.1.1';

/**
 * The MCP server Claude Code talks to. It declares the `claude/channel`
 * capability (so the hub can push messages into the session) and tools.
 * Permission relay is deliberately NOT declared: approving tool use stays
 * with the human at this laptop.
 */
export function createMcpServer(
  instructions: string,
  deps: ToolDeps | { problems: string[] },
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> =>
      callTool(request.params.name, request.params.arguments, deps),
  );
  return server;
}

/** Pushes one event into the session as a `<channel>` tag. */
export function pushEvent(server: Server, event: ChannelEvent): Promise<void> {
  return server.notification({
    method: 'notifications/claude/channel',
    params: { content: event.content, meta: event.meta },
  });
}
