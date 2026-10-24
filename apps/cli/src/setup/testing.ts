import { DiscordConfig } from '@agentmesh/config';
import type { z } from 'zod';
import type { SetupAnswers } from './answers';
import { DISCORD_API } from './discord-api';

export type AnswersInput = z.input<typeof SetupAnswers>;

/** `docker compose ps --format json` for a healthy stack. */
export const HEALTHY_CONTAINERS = [
  { Service: 'nats', State: 'running', Health: '' },
  { Service: 'hub', State: 'running', Health: 'healthy' },
  { Service: 'discord-bridge', State: 'running', Health: '' },
]
  .map((row) => JSON.stringify(row))
  .join('\n');

const discord = DiscordConfig.parse({});
/** A Discord server with the default category, channels and planning forum. */
export const MESH_CHANNELS = [
  { id: '300000000000000003', name: 'Agent Mesh', type: 4, parent_id: null },
  ...Object.values(discord.channels).map((c, i) => ({
    id: `30000000000000001${i}`,
    name: c.name,
    type: c.type === 'forum' ? 15 : 0,
    parent_id: '300000000000000003',
  })),
];

/**
 * A fake Discord API for `ctx.fetch`. Each path answers with its JSON body, or calls its
 * function for a fresh body or `Response`; other paths answer 404. Requests are recorded.
 */
export function fakeDiscord(routes: Record<string, unknown>) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    const route = routes[url.slice(DISCORD_API.length)];
    const answer = typeof route === 'function' ? route() : route;
    if (answer instanceof Response) return answer;
    return answer === undefined ? new Response(null, { status: 404 }) : Response.json(answer);
  };
  return { fetch: fetchImpl as typeof fetch, requests };
}

/** Test answers for a server at mesh.acme.dev: admin riya, teammate dana (owner of `security`). */
export function serverAnswers(): AnswersInput {
  return {
    version: 1,
    team: {
      name: 'Acme',
      meshName: 'acme',
      overview: 'Acme builds invoicing software for small shops.',
      repos: ['acme/api', 'acme/web'],
    },
    admin: {
      id: 'riya',
      name: 'Riya',
      roles: ['backend lead'],
      skills: ['backend', 'api'],
      discordUsername: 'riya',
      githubUsername: 'riya-gh',
    },
    people: [
      {
        id: 'dana',
        name: 'Dana',
        roles: ['security'],
        skills: ['security'],
        discordUsername: 'dana',
      },
    ],
    decisions: { finalSay: 'riya' },
    areas: [
      {
        id: 'security',
        description: 'Auth, secrets and permissions',
        owners: ['dana'],
        skills: ['security'],
      },
    ],
    hosting: { mode: 'server', ssh: 'deploy@mesh.acme.dev', publicHost: 'mesh.acme.dev' },
  };
}

/** The same team as a trial on this machine, with a second test agent. */
export function trialAnswers(): AnswersInput {
  return { ...serverAnswers(), hosting: { mode: 'trial', testAgent: true } };
}
