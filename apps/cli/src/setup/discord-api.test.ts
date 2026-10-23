import { describe, expect, it } from 'vitest';
import { botInviteUrl, DISCORD_API, discordApi } from './discord-api';
import { fakeDiscord } from './testing';

const TOKEN = 'tok-SECRET-123';
const BOT = { id: '100000000000000001', username: 'acme-bot', avatar: null };

/** The error a call rejects with (or throws), so its message can be checked for the token. */
async function failure(call: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await call();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected the call to fail');
}

describe('discordApi', () => {
  it('sends the bot token only in the Authorization header', async () => {
    const discord = fakeDiscord({ '/users/@me': BOT });
    expect(await discordApi(TOKEN, discord.fetch).me()).toEqual({
      id: BOT.id,
      username: 'acme-bot',
    });
    expect(discord.requests).toHaveLength(1);
    const [request] = discord.requests;
    expect(request?.url).toBe(`${DISCORD_API}/users/@me`);
    const headers = new Headers(request?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bot ${TOKEN}`);
    headers.delete('authorization');
    expect(JSON.stringify([request?.url, request?.init?.body, [...headers]])).not.toContain(TOKEN);
  });

  it('401 → unauthenticated, message has no token', async () => {
    // Even a body that echoed the token must not reach the message.
    const discord = fakeDiscord({
      '/users/@me': () => Response.json({ message: `bad token ${TOKEN}` }, { status: 401 }),
    });
    const error = await failure(() => discordApi(TOKEN, discord.fetch).me());
    expect(error.code).toBe('unauthenticated');
    expect(error.message).toContain('Discord rejected the bot token in deploy/.env (401)');
    expect(error.message).not.toContain(TOKEN);
  });

  it('any other status → unavailable, naming the path', async () => {
    const discord = fakeDiscord({ '/guilds/42': () => new Response(null, { status: 500 }) });
    const error = await failure(() => discordApi(TOKEN, discord.fetch).guild('42'));
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'Discord API /guilds/42 answered 500',
    });
  });

  it('refuses a token that could not go into a header, without echoing it', async () => {
    const discord = fakeDiscord({ '/users/@me': BOT });
    for (const token of [`${TOKEN}\u0000x`, `“${TOKEN}”`, `${TOKEN} x`]) {
      const error = await failure(async () => discordApi(token, discord.fetch).me());
      expect(error.code).toBe('unauthenticated');
      expect(error.message).not.toContain(TOKEN);
    }
    expect(discord.requests).toHaveLength(0);
  });

  it('parses channels, with a missing parent as null', async () => {
    const [category, council] = ['500000000000000005', '600000000000000006'];
    const discord = fakeDiscord({
      '/guilds/42/channels': [
        { id: category, name: 'AgentMesh', type: 4, position: 0 },
        { id: council, name: 'mesh-council', type: 0, parent_id: category },
      ],
    });
    expect(await discordApi(TOKEN, discord.fetch).channels('42')).toEqual([
      { id: category, name: 'AgentMesh', type: 4, parent_id: null },
      { id: council, name: 'mesh-council', type: 0, parent_id: category },
    ]);
  });

  it('builds the invite link with the bot scopes and permissions', () => {
    expect(botInviteUrl('100000000000000001')).toBe(
      'https://discord.com/oauth2/authorize?client_id=100000000000000001' +
        '&scope=bot+applications.commands&permissions=326954470480',
    );
  });
});
