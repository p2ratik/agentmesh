#!/usr/bin/env node
// Hand-run probe: what does Claude Code give an MCP server for cross-session messaging, and is
// the server's parent the `claude` process? Run once: node <plugin dir>/scripts/probe-messaging.mjs
// It starts one `claude -p` that loads no settings or plugins, so nothing reaches the mesh.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function maskSocket(socket, home) {
  const next = socket[home.length];
  const inHome =
    home && socket.startsWith(home) && (next === undefined || next === '/' || next === '\\');
  const rel = inHome ? `~${socket.slice(home.length)}` : socket;
  return rel.replace(/[0-9a-fA-F]{8,}/g, (run) => `<${run.length} hex>`);
}

/** A stderr line: the home folder becomes ~ wherever it appears, then hex runs are masked. */
export function maskLine(line, home) {
  return maskSocket(home ? line.split(home).join('~') : line, home);
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
  const clean = () => rmSync(dir, { recursive: true, force: true });
  const onSignal = (sig) => {
    clean();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
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
      const line = (run.stderr ?? '').split('\n').find((l) => l.trim());
      console.log(`The probe server never started (claude exit ${run.status ?? 'none'}).`);
      if (run.error?.code) console.log(`error: ${run.error.code}`);
      if (line) console.log(`stderr: ${maskLine(line.trim(), homedir())}`);
      return;
    }
    const { socket, ppid, parentName } = JSON.parse(readFileSync(log, 'utf8'));
    console.log(`socket: ${socket ? maskSocket(socket, homedir()) : 'none'}`);
    console.log(
      `socket present: ${socket && existsSync(socket.replace(/^uds:/, '')) ? 'yes' : 'no'}`,
    );
    console.log(parentVerdict(ppid, run.pid, parentName));
  } finally {
    clean();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

function realOrRaw(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const direct =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realOrRaw(process.argv[1])).href;
if (direct) {
  const i = process.argv.indexOf('--stub');
  if (i > 0) stub(process.argv[i + 1]);
  else main();
}
