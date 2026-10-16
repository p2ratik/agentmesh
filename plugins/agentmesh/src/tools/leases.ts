import { z } from 'zod';
import { formatLeases } from './format';
import { defineTool, withKey } from './types';

export const leaseTools = [
  defineTool({
    name: 'lease',
    description:
      'Reserve path globs (e.g. "api/types/**") before editing a shared area. All-or-nothing: on conflict you get the holder to talk to.',
    input: z.object({
      paths: z.array(z.string().min(1)).min(1),
      repo: z.string().optional(),
      ttl_minutes: z.number().positive().optional(),
      reason: z.string().optional(),
      task_id: z.string().optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const r = await hub.call(
        'lease.acquire',
        {
          paths: args.paths,
          ...(args.repo ? { repo: args.repo } : {}),
          ...(args.ttl_minutes ? { ttlMinutes: args.ttl_minutes } : {}),
          ...(args.reason ? { reason: args.reason } : {}),
          ...(args.task_id ? { taskId: args.task_id } : {}),
        },
        withKey(key),
      );
      if (r.conflicts.length > 0) {
        const lines = r.conflicts.map(
          (c) => `- ${c.requested} overlaps ${c.held} held by ${c.holder} until ${c.expiresAt}`,
        );
        return `Not granted (nothing was leased):\n${lines.join('\n')}\nCoordinate with the holder(s) via ask.`;
      }
      return `Leased:\n${formatLeases(r.granted)}`;
    },
  }),
  defineTool({
    name: 'release',
    description: 'Release your leases on the given paths, or all of them.',
    input: z.object({ paths: z.array(z.string()).optional(), all: z.boolean().optional() }),
    mutating: false,
    run: async (args, { hub }) => {
      const r = await hub.call('lease.release', {
        ...(args.paths ? { paths: args.paths } : {}),
        all: args.all ?? false,
      });
      return `Released ${r.released} lease(s).`;
    },
  }),
  defineTool({
    name: 'leases',
    description: 'List active leases (optionally for one holder or repo).',
    input: z.object({ holder: z.string().optional(), repo: z.string().optional() }),
    mutating: false,
    run: async (args, { hub }) =>
      formatLeases(
        (
          await hub.call('lease.list', {
            ...(args.holder ? { holder: args.holder } : {}),
            ...(args.repo ? { repo: args.repo } : {}),
          })
        ).leases,
      ),
  }),
];
