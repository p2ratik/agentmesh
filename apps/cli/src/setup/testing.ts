import type { z } from 'zod';
import type { SetupAnswers } from './answers';

export type AnswersInput = z.input<typeof SetupAnswers>;

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
