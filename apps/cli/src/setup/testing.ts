import type { z } from 'zod';
import type { SetupAnswers } from './answers';
import { DISCORD_API } from './discord-api';

export type AnswersInput = z.input<typeof SetupAnswers>;

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
