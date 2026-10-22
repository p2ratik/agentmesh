import { MeshError } from '@agentmesh/common';
import { z } from 'zod';
import { defineTool } from './types';

const Description = z.string().min(1).max(200);
/** How long `activate` waits for the session to listen before asking for the check anyway. */
const LISTEN_WAIT_MS = 3000;

const CHECK_SENT =
  'Sent a test message to this session. If it arrives, call activate again with its code and a one-line description. If nothing arrives within a few seconds, this session was started without the channel flag: restart it with claude --dangerously-load-development-channels plugin:agentmesh@agentmesh.';

/** Opting this session in and out of the mesh, and moving work to it. */
export const sessionTools = [
  defineTool({
    name: 'activate',
    description:
      'Turn this session on for the mesh, only when your human asks (/agentmesh:activate). Until then it receives nothing.',
    input: z.object({ code: z.string().optional(), description: Description.optional() }),
    mutating: false,
    run: async (args, { hub, activation, listening }) => {
      if (args.code === undefined) {
        // The hub sends the code over this session's subject; only the push shows it to Claude,
        // so getting it back proves both legs. In the first seconds nobody listens there yet;
        // if that never changes, the hub's failure says why.
        await Promise.race([listening, new Promise((r) => setTimeout(r, LISTEN_WAIT_MS))]);
        await hub.call('session.check', {});
        return CHECK_SENT;
      }
      if (!args.description) {
        throw new MeshError(
          'invalid_request',
          'Pass description too: one line on what this session is working on.',
        );
      }
      const view = await hub.call('session.activate', {
        code: args.code,
        description: args.description,
      });
      activation.lastDescription = view.description ?? args.description;
      activation.renewedFrom = null;
      return `This session is active on the mesh as “${activation.lastDescription}”.`;
    },
  }),
  defineTool({
    name: 'deactivate',
    description:
      'Turn this session off for the mesh, when your human asks (/agentmesh:deactivate). It keeps the tools but receives nothing, and the work it owns is released.',
    input: z.object({}),
    mutating: false,
    run: async (_args, { hub, activation }) => {
      await hub.call('session.deactivate', {});
      activation.lastDescription = null;
      activation.renewedFrom = null;
      return 'This session no longer receives mesh messages, and the work it owned is released: its next messages go to another active session, or wait. The tools still work; /agentmesh:activate turns it back on.';
    },
  }),
  defineTool({
    name: 'describe_session',
    description:
      'Replace the one-line description teammates see for this session. Call it when the session’s focus changes.',
    input: z.object({ description: Description }),
    mutating: false,
    run: async (args, { hub, activation }) => {
      const view = await hub.call('session.describe', { description: args.description });
      if (view.active) activation.lastDescription = view.description;
      return `This session is now described as “${view.description ?? args.description}”.`;
    },
  }),
  defineTool({
    name: 'take',
    description:
      'Move a task or thread, and its messages, to this session, when your human asks (/agentmesh:take).',
    input: z
      .object({ task_id: z.string().optional(), thread_id: z.string().optional() })
      .refine((a) => (a.task_id === undefined) !== (a.thread_id === undefined), {
        message: 'Pass exactly one of task_id and thread_id.',
      }),
    mutating: false,
    run: async (args, { hub }) => {
      const r = await hub.call('session.take', {
        ...(args.task_id ? { taskId: args.task_id } : {}),
        ...(args.thread_id ? { threadId: args.thread_id } : {}),
      });
      return `Took ${r.threadId}${r.previousSession ? ` from session ${r.previousSession}` : ''}; its messages now come to this session.`;
    },
  }),
];
