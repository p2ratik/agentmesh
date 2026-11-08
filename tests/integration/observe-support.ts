import { type ChildProcess, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObservedEvent } from '@agentmesh/protocol';
import { createUser } from '@nats-io/nkeys';
import { cleanEnv, PLUGIN_CLI } from './support';

/** Helpers for the observability e2e files: the bundled `agentmesh timeline`, laptops, ports. */

export const NATS_BIN = process.env.AGENTMESH_TEST_NATS_BIN ?? '';

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Polls until `fn` returns something. */
export async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** `agentmesh timeline` from the plugin's bundle, with `home` as `~`; killed if it hangs. */
export function timeline(home: string, ...args: string[]): Promise<Run> {
  const started = Date.now();
  const env = { ...cleanEnv(), HOME: home, USERPROFILE: home };
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PLUGIN_CLI, 'timeline', ...args],
      { env, timeout: 20_000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ code, stdout, stderr, ms: Date.now() - started });
      },
    );
  });
}

/** One timeline line: time, the kind in its column, the session when several show, the text. */
export const line = (kind: string, text: string) =>
  new RegExp(String.raw`^\d\d:\d\d:\d\d  ${kind.padEnd(13)}  (\[\S+\] )?${text}$`, 'm');

export const jsonLines = (r: Run): ObservedEvent[] =>
  r.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as ObservedEvent);

/** A laptop that joined as `agentId`: agent.json points at its seed file, as join writes it. */
export function laptop(temps: string[], agentId: string, natsUrl: string, prefix: string) {
  const home = mkdtempSync(join(tmpdir(), 'am-e2e-obs-home-'));
  temps.push(home);
  const dir = join(home, '.agentmesh');
  mkdirSync(dir);
  const seed = new TextDecoder().decode(createUser().getSeed());
  const nkeySeed = join(dir, `${agentId}.nk`);
  writeFileSync(nkeySeed, `${seed}\n`);
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ agentId, natsUrl, nkeySeed, prefix }));
  return { home, seed };
}

/** A server listening on a free local port, and that port. */
export async function listening(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** A port that was free a moment ago: nothing listens on it. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listening(probe);
  await new Promise((r) => probe.close(r));
  return port;
}

/** Kills a nats-server and waits for it to exit (its store stays locked until then). */
export async function stop(p: ChildProcess | undefined): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const exited = once(p, 'exit');
  p.kill();
  await exited;
}

/**
 * Resolves once a nats-server started with stderr piped says "Server is ready". Its stderr is
 * collected first, since the line can arrive split across chunks; it rejects if the server exits
 * first or `timeoutMs` passes, with what it printed.
 */
export function natsReady(p: ChildProcess, timeoutMs = 10_000): Promise<void> {
  let printed = '';
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`nats-server not ready: ${printed}`)), timeoutMs);
    const onData = (b: Buffer) => {
      printed += b.toString();
      if (printed.includes('Server is ready')) done();
    };
    const onExit = (code: number | null) =>
      done(new Error(`nats-server exited (${code}) before it was ready: ${printed}`));
    function done(error?: Error) {
      clearTimeout(timer);
      p.stderr?.off('data', onData);
      p.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    }
    p.stderr?.on('data', onData);
    p.once('exit', onExit);
  });
}
