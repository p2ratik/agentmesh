import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@agentmesh/config';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../context';
import { humanDiscordId } from '../../lib/mesh-document';
import { runCli } from '../../main';
import { botInviteUrl } from '../../setup/discord-api';
import { readEnvFile, updateEnvFile } from '../../setup/env-file';
import { fakeDiscord, trialAnswers } from '../../setup/testing';
import { readState, workspacePaths } from '../../setup/workspace';

const TOKEN = 'tok-SECRET-123';
const APP = '100000000000000001';
const GUILD = '200000000000000002';
const OTHER_GUILD = '300000000000000003';
const OWNER = '400000000000000004';
const ADMIN = '500000000000000005';

/** Discord as the bot sees it once it has joined `guilds`; riya owns the Acme server. */
function discordRoutes(guilds: unknown = [{ id: GUILD, name: 'Acme', icon: null }]) {
  return {
    '/users/@me': { id: '900000000000000009', username: 'acme-bot', bot: true },
    '/applications/@me': { id: APP, name: 'Acme Mesh' },
    '/users/@me/guilds': guilds,
    [`/guilds/${GUILD}`]: { id: GUILD, name: 'Acme', owner_id: OWNER },
    [`/users/${OWNER}`]: { id: OWNER, username: 'riya' },
    [`/users/${ADMIN}`]: { id: ADMIN, username: 'riya.admin' },
  };
}

/** A rendered trial workspace whose .env has `tokenValue`, talking to a fake Discord. */
async function rendered(routes: Record<string, unknown>, tokenValue = TOKEN) {
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-setup-discord-'));
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const discord = fakeDiscord(routes);
  const ctx: CliContext = {
    cwd,
    env: {},
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    fetch: discord.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const run = (...argv: string[]) => runCli(argv, ctx);
  const p = workspacePaths(join(cwd, 'ws'));
  mkdirSync(p.root);
  writeFileSync(p.answers, JSON.stringify(trialAnswers()));
  expect(await run('setup', 'render', '--dir', p.root)).toBe(0);
  updateEnvFile(p.envFile, { DISCORD_BOT_TOKEN: tokenValue });
  const env = () => readEnvFile(p.envFile);
  const all = () => [...out, ...err].join('\n');
  return {
    p,
    out,
    err,
    sleeps,
    discord,
    env,
    all,
    discordStep: (...a: string[]) => run('setup', 'discord', '--dir', p.root, ...a),
  };
}

describe('setup discord', () => {
  it("fills DISCORD_APP_ID and DISCORD_GUILD_ID and the admin's discordUserId", async () => {
    const t = await rendered(discordRoutes());
    expect(await t.discordStep()).toBe(0);
    expect(t.env().get('DISCORD_APP_ID')).toBe(APP);
    expect(t.env().get('DISCORD_GUILD_ID')).toBe(GUILD);
    expect(t.env().get('DISCORD_BOT_TOKEN')).toBe(TOKEN);
    expect(humanDiscordId(readFileSync(t.p.meshFile, 'utf8'), 'riya')).toBe(OWNER);
    expect(readState(t.p).done.discord).toBeDefined();
    // The workspace is now valid with the real .env, no stand-ins needed.
    loadConfig(t.p.configDir, { env: Object.fromEntries(t.env()) });

    expect(t.out).toContain('Bot: acme-bot');
    expect(t.out).toContain(`Add the bot to your server: ${botInviteUrl(APP)}`);
    expect(t.all()).toContain(
      'Admin Discord account: riya (the server owner). If that is not you, run again with ' +
        '--admin-discord-id <your id>.',
    );
    expect(t.all()).not.toContain(TOKEN);
    expect(t.sleeps).toEqual([]);
  });

  it('reads a quoted token with trailing spaces', async () => {
    const t = await rendered(discordRoutes(), `"${TOKEN}"   `);
    expect(await t.discordStep()).toBe(0);
    for (const { init } of t.discord.requests) {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bot ${TOKEN}`);
    }
    expect(t.all()).not.toContain(TOKEN);
  });

  it('401 → unauthenticated, message has no token', async () => {
    const routes = {
      ...discordRoutes(),
      '/users/@me': () => Response.json({ message: `bad token ${TOKEN}` }, { status: 401 }),
    };
    const t = await rendered(routes);
    expect(await t.discordStep()).toBe(1);
    expect(t.err.at(-1)).toContain('Discord rejected the bot token in deploy/.env (401)');
    expect(t.all()).not.toContain(TOKEN);
    expect(t.env().get('DISCORD_APP_ID')).toBe('');
    expect(readState(t.p).done.discord).toBeUndefined();
  });

  it('403 on the server says the bot lacks access, not that the token is bad', async () => {
    const routes = {
      ...discordRoutes(),
      [`/guilds/${GUILD}`]: () => new Response(null, { status: 403 }),
    };
    const t = await rendered(routes);
    expect(await t.discordStep()).toBe(1);
    expect(t.err.at(-1)).toBe(
      `error: Discord API /guilds/${GUILD} answered 403: the bot has no access there. ` +
        'Is it still in the server, with the permissions from the invite link?',
    );
    expect(t.all()).not.toMatch(/reset/i);
    expect(t.all()).not.toContain(TOKEN);
    expect(t.env().get('DISCORD_GUILD_ID')).toBe('');
    expect(readState(t.p).done.discord).toBeUndefined();
  });

  it('an empty token asks for it in the file, never in the chat', async () => {
    const t = await rendered(discordRoutes(), '');
    expect(await t.discordStep()).toBe(1);
    expect(t.err.at(-1)).toBe(
      `Paste your bot token into ${t.p.envFile} after DISCORD_BOT_TOKEN=, save, and run again. ` +
        'Do not paste it into the chat.',
    );
    expect(t.discord.requests).toHaveLength(0);
  });

  it('waits, then gives up when the bot joins no server', async () => {
    const t = await rendered(discordRoutes([]));
    expect(await t.discordStep('--wait-seconds', '9')).toBe(1);
    expect(t.sleeps).toEqual([3000, 3000, 3000]);
    expect(t.err.at(-1)).toBe(
      'The bot is not in a server yet. Open the link above, add it, and run setup discord again.',
    );
    expect(t.env().get('DISCORD_GUILD_ID')).toBe('');
    expect(humanDiscordId(readFileSync(t.p.meshFile, 'utf8'), 'riya')).toBeNull();
    expect(readState(t.p).done.discord).toBeUndefined();
    expect(await t.discordStep('--wait-seconds', 'soon')).toBe(2);
  });

  it('keeps polling until the bot joins', async () => {
    let polls = 0;
    const joined = [{ id: GUILD, name: 'Acme' }];
    const t = await rendered(discordRoutes(() => (++polls < 3 ? [] : joined)));
    expect(await t.discordStep()).toBe(0);
    expect(t.sleeps).toEqual([3000, 3000]);
    expect(t.env().get('DISCORD_GUILD_ID')).toBe(GUILD);
  });

  it('several servers without --guild lists them', async () => {
    const guilds = [
      { id: GUILD, name: 'Acme' },
      { id: OTHER_GUILD, name: 'Gaming' },
    ];
    const t = await rendered(discordRoutes(guilds));
    expect(await t.discordStep()).toBe(1);
    const message = t.err.at(-1);
    expect(message).toContain(`Acme (${GUILD})`);
    expect(message).toContain(`Gaming (${OTHER_GUILD})`);
    expect(message).toContain('run again with --guild <id>');
    expect(t.env().get('DISCORD_GUILD_ID')).toBe('');

    expect(await t.discordStep('--guild', '700000000000000007')).toBe(1);
    expect(t.err.at(-1)).toContain(`Acme (${GUILD})`);
    expect(t.env().get('DISCORD_GUILD_ID')).toBe('');

    expect(await t.discordStep('--guild', GUILD)).toBe(0);
    expect(t.env().get('DISCORD_GUILD_ID')).toBe(GUILD);
  });

  it('--admin-discord-id wins over the owner', async () => {
    const t = await rendered(discordRoutes());
    expect(await t.discordStep('--admin-discord-id', ADMIN)).toBe(0);
    expect(humanDiscordId(readFileSync(t.p.meshFile, 'utf8'), 'riya')).toBe(ADMIN);
    expect(t.all()).toContain('Admin Discord account: riya.admin (given).');

    expect(await t.discordStep('--admin-discord-id', 'riya')).toBe(2);
    expect(t.err.at(-1)).toContain('--admin-discord-id');
    expect(humanDiscordId(readFileSync(t.p.meshFile, 'utf8'), 'riya')).toBe(ADMIN);
  });
});
