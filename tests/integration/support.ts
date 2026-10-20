import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** The bundled plugin, spawned exactly like Claude Code spawns it. */
export const PLUGIN = join(import.meta.dirname, '../../plugins/agentmesh/dist/server.js');

export interface Channel {
  content: string;
  meta: Record<string, string>;
}

export interface Agent {
  client: Client;
  events: Channel[];
  /** The method of every notification the plugin sent, in order. */
  notifications: string[];
  /** Everything the plugin logged so far (it logs to stderr). */
  stderr(): string;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  waitFor(match: (e: Channel) => boolean, timeoutMs?: number): Promise<Channel>;
}

export interface AgentEnv {
  /** Empty, with an empty natsUrl, starts an unenrolled plugin that offers only `join`. */
  agentId: string;
  natsUrl: string;
  prefix: string;
  nkeySeed?: string;
  /** Home directory holding `.agentmesh` (agent.json, keys, invite.txt). */
  home?: string;
}

/** Starts one plugin process over MCP stdio and records its channel events. */
export async function spawnAgent(env: AgentEnv): Promise<Agent> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PLUGIN],
    env: {
      ...process.env,
      ...(env.home ? { HOME: env.home, USERPROFILE: env.home } : {}),
      AGENTMESH_AGENT_ID: env.agentId,
      AGENTMESH_NATS_URL: env.natsUrl,
      AGENTMESH_PREFIX: env.prefix,
      AGENTMESH_NKEY_SEED: env.nkeySeed ?? '',
      AGENTMESH_LOG_FILE: '',
    },
    stderr: 'pipe',
  });
  const logged: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => logged.push(chunk.toString('utf8')));
  const client = new Client({ name: `e2e-${env.agentId || 'joiner'}`, version: '0.0.0' });
  const events: Channel[] = [];
  const notifications: string[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n.method);
    if (n.method === 'notifications/claude/channel') events.push(n.params as unknown as Channel);
  };
  await client.connect(transport);
  return {
    client,
    events,
    notifications,
    stderr: () => logged.join(''),
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      if (result.isError) throw new Error(text);
      return text;
    },
    async waitFor(match, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = events.find(match);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`${env.agentId}: no matching channel event; got ${JSON.stringify(events)}`);
    },
  };
}

/** Retries a tool call until the hub answers (plugins connect in the background). */
export async function untilConnected<T>(fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
