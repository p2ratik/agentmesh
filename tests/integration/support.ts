import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcClient } from '@agentmesh/bus';
import type { RpcMethodName, RpcParamsInput, RpcResult } from '@agentmesh/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** The bundled plugin, spawned exactly like Claude Code spawns it. */
export const PLUGIN = join(import.meta.dirname, '../../plugins/agentmesh/dist/server.js');
/** The `agentmesh` CLI bundled in the plugin, which `/agentmesh:setup` runs. */
export const PLUGIN_CLI = join(import.meta.dirname, '../../plugins/agentmesh/dist/cli.js');

/** The mesh window marker the e2e windows carry; `windowHome`'s policy holds it. */
export const WINDOW_TOKEN = '0123456789abcdef0123456789abcdef';

/** A temp home whose ~/.agentmesh/mesh-window.json makes bob-agent's marked session verify. */
export function windowHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'am-e2e-home-'));
  mkdirSync(join(home, '.agentmesh'));
  const policy = {
    version: 1,
    agentId: 'bob-agent',
    token: WINDOW_TOKEN,
    ownBranchPrefix: 'agent/bob-agent/',
    integrationBranch: 'agents',
    testCommands: [],
  };
  writeFileSync(join(home, '.agentmesh', 'mesh-window.json'), JSON.stringify(policy));
  return home;
}

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
  /** The temp CLAUDE_PLUGIN_DATA folder spawnAgent made; removed when the plugin closes. */
  dataDir: string;
  /** The result's text parts, joined by newlines; throws on an error result. */
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
  /** Set last, e.g. the mesh window marker or a CLAUDE_PLUGIN_DATA of the test's own. */
  extraEnv?: Record<string, string>;
}

/**
 * This process's environment without the Claude Code and AgentMesh variables of the session
 * running the tests: a spawned bundle runs in no mesh window, with no messaging address, relay
 * setting or seed, unless the test says so.
 */
export function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !/^(CLAUDE|AGENTMESH)/.test(e[0]),
    ),
  );
}

/** Starts one plugin process over MCP stdio and records its channel events. */
export async function spawnAgent(env: AgentEnv): Promise<Agent> {
  const inherited = cleanEnv();
  const dataDir = mkdtempSync(join(tmpdir(), 'am-e2e-data-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PLUGIN],
    env: {
      ...inherited,
      ...(env.home ? { HOME: env.home, USERPROFILE: env.home } : {}),
      AGENTMESH_AGENT_ID: env.agentId,
      AGENTMESH_NATS_URL: env.natsUrl,
      AGENTMESH_PREFIX: env.prefix,
      AGENTMESH_NKEY_SEED: env.nkeySeed ?? '',
      AGENTMESH_LOG_FILE: '',
      // State and heartbeat files land here, never in the real ~/.agentmesh/run.
      CLAUDE_PLUGIN_DATA: dataDir,
      ...env.extraEnv,
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
  // Fires once the plugin process has exited, before client.close() resolves.
  client.onclose = () => rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  return {
    client,
    events,
    notifications,
    stderr: () => logged.join(''),
    dataDir,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      // Every part: hub notes and the FYI ride-along follow the tool's own text.
      const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
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

/**
 * Opts the session in the way Claude does after /agentmesh:activate: asks for
 * a check (retrying until the plugin listens on its session subject), reads the
 * code the hub pushed, and sends it back with a description. Returns the final result's text.
 */
export async function activate(agent: Agent, description: string): Promise<string> {
  const before = agent.events.length;
  await untilConnected(() => agent.call('activate', {}));
  const check = await agent.waitFor(
    (e) => agent.events.indexOf(e) >= before && e.content.includes('Code:'),
  );
  const code = /Code: (\w+)/.exec(check.content)?.[1] ?? '';
  return agent.call('activate', { code, description });
}

/** Calls the hub as a fresh session of the client's agent: the hub refuses agent calls without one. */
export async function callAsSession<M extends RpcMethodName>(
  rpc: RpcClient,
  method: M,
  params: RpcParamsInput<M>,
): Promise<RpcResult<M>> {
  const { sessionId } = await rpc.call('session.hello', { clientVersion: '0.3.0' });
  return rpc.call(method, params, { session: sessionId });
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
