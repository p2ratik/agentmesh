import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUser } from '@nats-io/nkeys';
import { afterAll, describe, expect, it } from 'vitest';
import {
  freePort,
  laptop,
  listening,
  NATS_BIN,
  natsReady,
  stop,
  timeline,
} from './observe-support';
import { PLUGIN_CLI } from './support';

/**
 * `agentmesh timeline` from the plugin's bundle when it can't get through: a nats-server that
 * refuses its key, a port nothing listens on, and a server that never says a word. No hub needed.
 * Needs AGENTMESH_TEST_NATS_BIN and a built plugin.
 */
describe.skipIf(!NATS_BIN || !existsSync(NATS_BIN) || !existsSync(PLUGIN_CLI))(
  'agentmesh timeline when it cannot get through',
  () => {
    const temps: string[] = [];
    const servers: ChildProcess[] = [];
    afterAll(async () => {
      await Promise.all(servers.map(stop));
      for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    });

    it('exits 1 with a clear message when NATS refuses its key, with no credentials shown', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-e2e-obs-auth-'));
      temps.push(dir);
      const port = await freePort();
      // This NATS knows one nkey, and it is not the laptop's.
      const users = `authorization { users: [{ nkey: "${createUser().getPublicKey()}" }] }`;
      writeFileSync(join(dir, 'nats.conf'), `port: ${port}\n${users}\n`);
      const auth = spawn(NATS_BIN, ['-c', join(dir, 'nats.conf'), '-a', '127.0.0.1'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      servers.push(auth);
      await natsReady(auth);
      const { home, seed } = laptop(temps, 'alice-agent', `nats://127.0.0.1:${port}`, 'mesh');
      const r = await timeline(home);
      expect(r).toMatchObject({ code: 1, stdout: '' });
      // A refusal, or a reset before its -ERR is read (Windows): both name the refused key.
      expect(r.stderr).toMatch(/^error: .*refused alice-agent's key/);
      expect(r.stderr).not.toMatch(/Authorization Violation|ECONNRESET/);
      expect(r.stderr).not.toContain(seed);
    }, 30_000);

    it('exits 1 in bounded time when the hub is unreachable', async () => {
      // A port nothing listens on, and a server that accepts and never says a word.
      const silent = createServer((socket) => socket.on('error', () => undefined));
      try {
        const closed = await freePort();
        for (const port of [closed, await listening(silent)]) {
          const url = `nats://127.0.0.1:${port}`;
          const { home, seed } = laptop(temps, 'alice-agent', url, 'mesh');
          const r = await timeline(home);
          expect(r.code).toBe(1);
          expect(r.stdout).toBe('');
          expect(r.stderr).toMatch(/^error: /);
          if (port === closed) expect(r.stderr).toContain(`Could not reach the hub at ${url}`);
          expect(r.stderr).not.toContain(seed);
          // connectOnce gives up after 5 s; the process must not stay open after that.
          expect(r.ms).toBeLessThan(12_000);
        }
      } finally {
        silent.close();
      }
    }, 40_000);
  },
);
