import { MeshError } from '@agentmesh/common';
import { ParticipantId } from '@agentmesh/protocol';
import { z } from 'zod';
import { DEFAULT_REMOTE_DIR } from './defaults';

/**
 * `setup-answers.json`: what Claude learned in the setup interview. It feeds the
 * first render and the invite lines; after that the workspace files are the truth.
 */

export const Person = z.object({
  id: ParticipantId,
  name: z.string().min(1).max(80),
  roles: z.array(z.string().min(1).max(40)).max(10).default([]),
  skills: z.array(z.string().min(1).max(40)).max(20).default([]),
  discordUsername: z.string().min(2).max(40),
});
export type Person = z.infer<typeof Person>;

export const Hosting = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('server'),
    /** `user@host`. Neither part may start with `-`, which ssh would read as an option. */
    ssh: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/),
    /**
     * A DNS name whose labels start and end with a letter or digit, in lowercase: certbot
     * names /etc/letsencrypt/live/<name> in lowercase, and the renewal hook reads it there.
     */
    publicHost: z
      .string()
      .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i)
      .toLowerCase(),
    remoteDir: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]+$/)
      .default(DEFAULT_REMOTE_DIR),
  }),
  z.object({ mode: z.literal('trial'), testAgent: z.boolean().default(false) }),
]);
export type Hosting = z.infer<typeof Hosting>;

export const SetupAnswers = z
  .object({
    version: z.literal(1),
    team: z.object({
      name: z.string().min(1).max(60),
      meshName: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
      overview: z.string().min(1).max(1200),
      repos: z.array(z.string()).default([]),
    }),
    admin: Person.extend({
      githubUsername: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,39}$/)
        .optional(),
    }),
    /** Everyone except the admin. */
    people: z.array(Person).default([]),
    decisions: z.object({
      finalSay: ParticipantId,
      plansNeedApproval: z.boolean().default(true),
    }),
    areas: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
          description: z.string().min(1),
          owners: z.array(ParticipantId).min(1),
          skills: z.array(z.string()).default([]),
        }),
      )
      .min(1),
    git: z
      .object({
        integrationBranch: z.string().default('agents'),
        /** The team policy names them, so there is at least one. */
        protectedBranches: z.array(z.string()).min(1).default(['main']),
      })
      .prefault({}),
    hosting: Hosting,
  })
  .superRefine((a, ctx) => {
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const everyone: Array<{ person: Person; path: (string | number)[] }> = [
      { person: a.admin, path: ['admin'] },
      ...a.people.map((person, i) => ({ person, path: ['people', i] })),
    ];
    const ids = new Set<string>();
    const usernames = new Set<string>();
    for (const { person, path } of everyone) {
      if (ids.has(person.id)) add([...path, 'id'], `duplicate person id "${person.id}"`);
      ids.add(person.id);
      if (person.id.endsWith('-agent')) {
        add([...path, 'id'], 'must not end in -agent (the agent id adds it)');
      }
      const username = person.discordUsername.toLowerCase();
      if (usernames.has(username)) {
        add([...path, 'discordUsername'], `duplicate Discord username "${username}"`);
      }
      usernames.add(username);
    }
    const notPerson = (id: string) => `"${id}" is not the admin or one of the people`;
    if (!ids.has(a.decisions.finalSay)) {
      add(['decisions', 'finalSay'], notPerson(a.decisions.finalSay));
    }
    a.areas.forEach((area, i) => {
      area.owners.forEach((owner, j) => {
        if (!ids.has(owner)) add(['areas', i, 'owners', j], notPerson(owner));
      });
    });
  });
export type SetupAnswers = z.infer<typeof SetupAnswers>;

/** Validates raw answers; every problem becomes one "path: message" line. */
export function parseAnswers(raw: unknown): SetupAnswers {
  const parsed = SetupAnswers.safeParse(raw);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new MeshError('invalid_request', `Invalid setup answers:\n${lines.join('\n')}`);
}

export const agentIdOf = (personId: string): string => `${personId}-agent`;

/** The admin's roles as mesh.yaml lists them: `admin` first, no duplicates. */
export const adminRoles = (a: SetupAnswers): string[] => [...new Set(['admin', ...a.admin.roles])];

/** The admin (with their mesh.yaml roles), then the people. */
export const everyone = (a: SetupAnswers): Person[] => [
  { ...a.admin, roles: adminRoles(a) },
  ...a.people,
];
