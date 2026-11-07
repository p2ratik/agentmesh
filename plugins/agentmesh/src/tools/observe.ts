import { z } from 'zod';
import { defineTool } from './types';

export const observeTools = [
  defineTool({
    name: 'timeline',
    description:
      "Operator only: this mesh's event timeline for an agent, session or thread (no message contents). Others are refused.",
    input: z.object({
      agent: z.string().optional(),
      session: z.string().optional(),
      thread_id: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
    mutating: false,
    run: async (args, { hub }) => {
      const r = await hub.call('observe.timeline', {
        ...(args.agent ? { agent: args.agent } : {}),
        ...(args.session ? { session: args.session } : {}),
        ...(args.thread_id ? { thread: args.thread_id } : {}),
        ...(args.since ? { since: args.since } : {}),
        ...(args.until ? { until: args.until } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      });
      return r.text; // the hub's text already carries the truncated note
    },
  }),
];
