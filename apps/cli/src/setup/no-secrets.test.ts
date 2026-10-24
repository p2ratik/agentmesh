import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../context';
import { runCli } from '../main';
import { updateEnvFile } from './env-file';
import { fakeDiscord, HEALTHY_CONTAINERS, MESH_CHANNELS, serverAnswers } from './testing';
import { workspacePaths } from './workspace';

const TOKEN = 'tok-SECRET-123';
const APP = '100000000000000001';
const GUILD = '200000000000000002';
const OWNER = '400000000000000004';

/** Discord with the bot in the Acme server, which has every channel the config names. */
const DISCORD = {
  '/users/@me': { id: '900000000000000009', username: 'acme-bot', bot: true },
  '/applications/@me': { id: APP, name: 'Acme Mesh' },
  '/users/@me/guilds': [{ id: GUILD, name: 'Acme', icon: null }],
  [`/guilds/${GUILD}`]: { id: GUILD, name: 'Acme', owner_id: OWNER },
  [`/users/${OWNER}`]: { id: OWNER, username: 'riya' },
  [`/guilds/${GUILD}/channels`]: MESH_CHANNELS,
};

/** Every seed file's content under `dirs`, read after the run. */
function seeds(dirs: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of dirs) {
    for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (file.endsWith('.nk')) found.set(basename(file), readFileSync(join(dir, file), 'utf8'));
    }
  }
  return found;
}

describe('setup secrets', () => {
  it('no step prints a secret', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-no-secrets-'));
    const seen: string[] = [];
    const ctx: CliContext = {
      cwd,
      env: {},
      homeDir: join(cwd, 'home'),
      stdout: (t) => seen.push(t),
      stderr: (t) => seen.push(t),
      // A 401 whose body echoes the token, as a careless proxy might.
      fetch: fakeDiscord({
        '/users/@me': () => Response.json({ message: `bad token ${TOKEN}` }, { status: 401 }),
      }).fetch,
      sleep: async () => {},
      run: async (_cmd, args, opts) => {
        seen.push(...args, opts?.input ?? '');
        return { code: 0, stdout: HEALTHY_CONTAINERS, stderr: '' };
      },
      lookup: async () => ['20.1.2.3'],
      probeNatsTls: async (host, port) => ({ ok: true, label: `${host}:${port} answers TLS` }),
      connectNats: async () => ({ close: async () => {} }),
    };
    const p = workspacePaths(join(cwd, 'acme'));
    mkdirSync(p.root);
    writeFileSync(p.answers, JSON.stringify(serverAnswers()));
    const step = (...argv: string[]) => runCli([...argv, '--dir', p.root], ctx);

    expect(await step('setup', 'render')).toBe(0);
    updateEnvFile(p.envFile, { DISCORD_BOT_TOKEN: TOKEN });
    expect(await step('setup', 'discord')).toBe(1);
    ctx.fetch = fakeDiscord(DISCORD).fetch;
    for (const argv of [
      ['setup', 'discord'],
      ['setup', 'host'],
      ['setup', 'deploy'],
      ['setup', 'admin'],
      ['setup', 'invites'],
      ['doctor'],
      ['setup', 'status'],
    ]) {
      expect(await step(...argv), argv.join(' ')).toBe(0);
    }

    const keys = seeds([p.root, ctx.homeDir]);
    expect([...keys.keys()].sort()).toEqual([
      'discord-bridge.nk',
      'hub-issuer.nk',
      'hub-sys.nk',
      'hub-xkey.nk',
      'hub.nk',
      'riya-agent.nk',
    ]);
    for (const secret of [TOKEN, ...[...keys.values()].map((seed) => seed.trim())]) {
      expect(seen.filter((text) => text.includes(secret))).toEqual([]);
    }
  });
});
