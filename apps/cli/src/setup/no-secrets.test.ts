import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../context';
import { runCli } from '../main';
import { updateEnvFile } from './env-file';
import { fakeDiscord, HEALTHY_CONTAINERS, MESH_CHANNELS, serverAnswers } from './testing';
import { workspacePaths } from './workspace';

// Discord-token-shaped and fake; built at runtime so secret scanners skip it.
const TOKEN = [`MTIz${'A'.repeat(22)}`, 'GaBcDe', 'F'.repeat(34)].join('.');
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

/** Every file under `dirs` (path → content), read after the run. */
function files(dirs: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of dirs) {
    for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const path = join(file.parentPath, file.name);
      found.set(path, readFileSync(path, 'utf8'));
    }
  }
  return found;
}

describe('setup secrets', () => {
  it('no step prints a secret, and only deploy/.env holds the token', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-no-secrets-'));
    const seen: string[] = [];
    // A failing command whose stderr echoes the token, as Docker Compose does for a bad .env.
    let failing = false;
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
        return failing
          ? { code: 1, stdout: '', stderr: `invalid line: DISCORD_BOT_TOKEN=${TOKEN}\n` }
          : { code: 0, stdout: HEALTHY_CONTAINERS, stderr: '' };
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
    expect(await step('setup', 'discord')).toBe(0);
    expect(await step('setup', 'host')).toBe(0);
    failing = true;
    expect(await step('setup', 'deploy')).toBe(1);
    failing = false;
    // The token pasted on the version line: deploy refuses it, upgrade replaces it.
    updateEnvFile(p.envFile, { AGENTMESH_VERSION: TOKEN });
    expect(await step('setup', 'deploy')).toBe(1);
    for (const argv of [
      ['upgrade'],
      ['setup', 'deploy'],
      ['setup', 'admin'],
      ['setup', 'invites'],
      ['doctor'],
      ['setup', 'status'],
    ]) {
      expect(await step(...argv), argv.join(' ')).toBe(0);
    }

    const all = files([p.root, ctx.homeDir]);
    const keys = [...all].filter(([path]) => path.endsWith('.nk'));
    expect(keys.map(([path]) => basename(path)).sort()).toEqual([
      'acme-riya-agent.nk',
      'discord-bridge.nk',
      'hub-issuer.nk',
      'hub-sys.nk',
      'hub-xkey.nk',
      'hub.nk',
    ]);
    for (const secret of [TOKEN, ...keys.map(([, seed]) => seed.trim())]) {
      expect(seen.filter((text) => text.includes(secret))).toEqual([]);
    }
    const holders = [...all].filter(([, text]) => text.includes(TOKEN));
    expect(holders.map(([path]) => relative(p.root, path))).toEqual([join('deploy', '.env')]);
  });
});
