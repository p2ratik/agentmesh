#!/usr/bin/env node
// Spawns the bundled plugin like Claude Code does and checks the MCP surface.
// Usage: node scripts/smoke.mjs [nats-url]   (default: a port nothing listens on)
// AGENTMESH_AGENT_ID / AGENTMESH_NKEY_SEED in the environment are passed through.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const natsUrl = process.argv[2] ?? 'nats://127.0.0.1:4999';
const started = Date.now();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, '..', 'dist', 'server.js')],
  env: {
    ...process.env,
    AGENTMESH_AGENT_ID: process.env.AGENTMESH_AGENT_ID ?? 'alice-agent',
    AGENTMESH_NATS_URL: natsUrl,
    AGENTMESH_NKEY_SEED: process.env.AGENTMESH_NKEY_SEED ?? '',
  },
  stderr: 'ignore',
});
const client = new Client({ name: 'agentmesh-smoke', version: '0.0.0' });
await client.connect(transport);
const handshakeMs = Date.now() - started;

const capabilities = client.getServerCapabilities();
const { tools } = await client.listTools();
const callStarted = Date.now();
const peers = await client.callTool({ name: 'peers', arguments: {} });
const callMs = Date.now() - callStarted;

console.log(
  JSON.stringify(
    {
      handshakeMs,
      channelCapability: Boolean(capabilities?.experimental?.['claude/channel']),
      permissionRelay: Boolean(capabilities?.experimental?.['claude/channel/permission']),
      instructions: client.getInstructions()?.slice(0, 120),
      tools: tools.map((t) => t.name),
      peers: { isError: peers.isError, text: peers.content?.[0]?.text, ms: callMs },
    },
    null,
    2,
  ),
);
await client.close();
