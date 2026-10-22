import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ChannelEvent } from './inbox/render';
import type { ToolListing, ToolResult } from './tools/registry';

export const SERVER_NAME = 'mesh';
export const VERSION = '0.3.0';

/** The tools the session offers right now; it changes when an unenrolled plugin joins. */
export interface ToolHandler {
  list(): ToolListing[];
  call(name: string, args: unknown): Promise<ToolResult>;
}

/**
 * The MCP server Claude Code talks to. It declares the `claude/channel`
 * capability (so the hub can push messages into the session) and tools.
 * Permission relay is deliberately NOT declared: approving tool use stays
 * with the human at this laptop.
 */
export function createMcpServer(instructions: string, handler: () => ToolHandler): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: { listChanged: true } },
      instructions,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: handler().list() }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> =>
      handler().call(request.params.name, request.params.arguments),
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
