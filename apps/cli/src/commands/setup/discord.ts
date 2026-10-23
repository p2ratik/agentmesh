import { readFileSync } from 'node:fs';
import { sleep } from '@agentmesh/common';
import { DiscordUserId } from '@agentmesh/protocol';
import { parseCommandArgs, usageError } from '../../args';
import type { Command } from '../../context';
import { writeFileAtomic } from '../../lib/files';
import { setHumanDiscordId } from '../../lib/mesh-document';
import { botInviteUrl, type DiscordApi, discordApi } from '../../setup/discord-api';
import { readEnvFile, updateEnvFile } from '../../setup/env-file';
import { loadAnswers, markDone, workspaceFrom } from '../../setup/workspace';

const OPTIONS = {
  dir: { type: 'string' },
  guild: { type: 'string' },
  'admin-discord-id': { type: 'string' },
  'wait-seconds': { type: 'string', default: '300' },
} as const;

const POLL_MS = 3000;

/** Asks Discord which servers the bot is in, every 3 s until it is in one or the wait runs out. */
async function waitForGuilds(api: DiscordApi, waitMs: number, wait: (ms: number) => Promise<void>) {
  let guilds = await api.guilds();
  for (let waited = 0; guilds.length === 0 && waited < waitMs; waited += POLL_MS) {
    await wait(POLL_MS);
    guilds = await api.guilds();
  }
  return guilds;
}

export const setupDiscordCommand: Command = {
  name: 'setup discord',
  summary: 'Check the bot token, then wait for the bot to join your Discord server',
  help: `Usage: agentmesh setup discord --dir <workspace> [--guild <id>] [--admin-discord-id <id>] [--wait-seconds 300]

Reads DISCORD_BOT_TOKEN from deploy/.env, checks it with Discord and prints the link
that adds the bot to a server. Waits up to --wait-seconds for the bot to join one,
then writes DISCORD_APP_ID and DISCORD_GUILD_ID to deploy/.env and the admin's
Discord id (the server owner unless --admin-discord-id) to config/mesh.yaml. If the
bot is in several servers, pick one with --guild. The token is never printed.`,
  async run(argv, ctx) {
    const { values } = parseCommandArgs(argv, OPTIONS, { min: 0, max: 0, names: '' });
    const waitSeconds = values['wait-seconds'];
    if (!/^\d+$/.test(waitSeconds)) throw usageError('--wait-seconds takes a whole number');
    const given = values['admin-discord-id'];
    if (given !== undefined && !DiscordUserId.safeParse(given).success) {
      throw usageError(
        '--admin-discord-id takes a Discord user id (digits, copied in Developer Mode)',
      );
    }
    const p = workspaceFrom(ctx, values.dir);
    const adminId = loadAnswers(p).admin.id;
    const token = readEnvFile(p.envFile).get('DISCORD_BOT_TOKEN') ?? '';
    if (!token) {
      ctx.stderr(
        `Paste your bot token into ${p.envFile} after DISCORD_BOT_TOKEN=, save, and run again. ` +
          'Do not paste it into the chat.',
      );
      return 1;
    }

    const api = discordApi(token, ctx.fetch ?? fetch);
    const bot = await api.me();
    const app = await api.application();
    updateEnvFile(p.envFile, { DISCORD_APP_ID: app.id });
    ctx.stdout(`Bot: ${bot.username}`);
    ctx.stdout(`Add the bot to your server: ${botInviteUrl(app.id)}`);

    const guilds = await waitForGuilds(api, Number(waitSeconds) * 1000, ctx.sleep ?? sleep);
    const listed = guilds.map((g) => `  ${g.name} (${g.id})`);
    if (guilds.length === 0) {
      ctx.stderr(
        'The bot is not in a server yet. Open the link above, add it, and run setup discord again.',
      );
      return 1;
    }
    if (guilds.length > 1 && !values.guild) {
      ctx.stderr(
        [
          'The bot is in several servers:',
          ...listed,
          'Pick one: run again with --guild <id>.',
        ].join('\n'),
      );
      return 1;
    }
    const chosen = values.guild ? guilds.find((g) => g.id === values.guild) : guilds[0];
    if (!chosen) {
      ctx.stderr([`The bot is not in server ${values.guild}. It is in:`, ...listed].join('\n'));
      return 1;
    }

    const guild = await api.guild(chosen.id);
    const admin = await api.user(given ?? guild.owner_id);
    // Prepared before anything is written, so an unknown admin leaves the files as they were.
    const mesh = setHumanDiscordId(readFileSync(p.meshFile, 'utf8'), adminId, admin.id);
    updateEnvFile(p.envFile, { DISCORD_GUILD_ID: guild.id });
    writeFileAtomic(p.meshFile, mesh);
    markDone(p, 'discord', new Date());

    ctx.stdout(
      [
        `Server: ${guild.name}`,
        `Admin Discord account: ${admin.username} (${given ? 'given' : 'the server owner'}). ` +
          'If that is not you, run again with --admin-discord-id <your id>.',
      ].join('\n'),
    );
    return 0;
  },
};
