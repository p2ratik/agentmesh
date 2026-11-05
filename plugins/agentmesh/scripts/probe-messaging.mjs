#!/usr/bin/env node
// Hand-run probe: what does Claude Code give an MCP server for cross-session messaging, and is
// the server's parent the `claude` process? Run once: node <plugin dir>/scripts/probe-messaging.mjs
// It starts one `claude -p` that loads no settings or plugins, so nothing reaches the mesh.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function maskSocket(socket, home) {
  const rel = home && socket.startsWith(home) ? `~${socket.slice(home.length)}` : socket;
  return rel.replace(/[0-9a-fA-F]{8,}/g, (run) => `<${run.length} hex>`);
}

export function parentVerdict(ppid, claudePid, parentName) {
  return `MCP server parent: ${parentName ?? 'unknown'} (pid ${ppid === claudePid ? 'matches' : 'does not match'} the claude process this probe started)`;
}

function parentNameOf(pid) {
  try {
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    const out = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
    return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
  } catch {
    return null;
  }
}

function stub(logFile) {
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null;
  const info = { socket, ppid: process.ppid, parentName: parentNameOf(process.ppid) };
  writeFileSync(logFile, JSON.stringify(info));
  const reply = (id, result) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return; // a notification needs no answer
    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '0.0.0' },
      });
    } else reply(msg.id, msg.method === 'tools/list' ? { tools: [] } : {});
  });
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-probe-'));
  try {
    const log = join(dir, 'probe.log');
    const config = join(dir, 'mcp.json');
    const me = fileURLToPath(import.meta.url);
    const servers = { probe: { command: process.execPath, args: [me, '--stub', log] } };
    writeFileSync(config, JSON.stringify({ mcpServers: servers }));
    const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    console.log(`claude --version: ${version.stdout?.trim() || 'not found'}`);
    console.log(`platform: ${process.platform}`);
    const run = spawnSync(
      'claude',
      [
        '-p',
        'Reply with the single word OK.',
        '--strict-mcp-config',
        '--mcp-config',
        config,
        '--setting-sources',
        'project',
      ],
      { cwd: dir, timeout: 120_000, encoding: 'utf8' },
    );
    if (!existsSync(log)) {
      console.log(`The probe server never started (claude exit ${run.status ?? 'none'}).`);
      return;
    }
    const { socket, ppid, parentName } = JSON.parse(readFileSync(log, 'utf8'));
    console.log(`socket: ${socket ? maskSocket(socket, homedir()) : 'none'}`);
    console.log(
      `socket present: ${socket && existsSync(socket.replace(/^uds:/, '')) ? 'yes' : 'no'}`,
    );
    console.log(parentVerdict(ppid, run.pid, parentName));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const i = process.argv.indexOf('--stub');
if (i > 0 && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  stub(process.argv[i + 1]);
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
