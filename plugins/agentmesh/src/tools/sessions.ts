import { MeshError } from '@agentmesh/common';
import { RESTART, START_COMMAND } from '@agentmesh/common/window';
import { z } from 'zod';
import type { MeshWindowContext } from '../window/context';
import { freshGuardStamp } from '../window/guard-stamp';
import { windowRules } from '../window/rules';
import { type ActivationState, activateSession, endRenewal } from './activation';
import { defineTool, ToolRefusal } from './types';

const Description = z.string().min(1).max(200);
/** How long `activate` waits for the session to listen before asking for the check anyway. */
const LISTEN_WAIT_MS = 3000;

const CHECK_SENT = `Sent a test message to this session. If it arrives, call activate again with its code and a one-line description. If nothing arrives within a few seconds, this session was started without the channel flag (Claude Desktop cannot pass that flag): call activate with pull: true and the description instead, and tell your human the session is pull-only. For instant pushes they can restart it with ${RESTART}.`;

const PULL_ACTIVE = `Nothing is pushed to this pull-only session: new mesh messages are announced on each prompt, and the inbox tool reads them. Tell your human; for instant pushes, restart the session with ${RESTART}.`;

const LAUNCHER = START_COMMAND;

const NOT_WINDOW =
  "This isn't your mesh window; team work will come here while no mesh window is running. Your human can turn it off with /agentmesh:deactivate and set up a mesh window with /agentmesh:window.";

/** With a window set up, setting one up again won't help; a stale `claude-mesh` (an old shell
 * function, say) can shadow the launcher. */
const WINDOW_NOT_STARTED = `This isn't your mesh window; team work will come here while no mesh window is running. Your human can turn it off with /agentmesh:deactivate. The mesh window is set up: your human starts it in a terminal with ${LAUNCHER}, because a session that's already running can't become the window. If ${LAUNCHER} started this session, something else named ${LAUNCHER} ran instead: check Get-Command ${LAUNCHER} -All (PowerShell) or type ${LAUNCHER} (bash).`;

const notWindow = (window: MeshWindowContext): string =>
  window.setUp ? WINDOW_NOT_STARTED : NOT_WINDOW;

const PULL_REFUSED = `This is your mesh window: it never runs pull-only. Call activate again with no arguments to send a new test message; if none arrives, the window was started without the channel flag, so tell your human to restart it with ${LAUNCHER}.`;

const WINDOW_CHECK_SENT = `Sent a test message to this session. If it arrives, call activate again with its code and a one-line description. If nothing arrives within a few seconds, call activate again with no arguments; if it still doesn't arrive, the window was started without the channel flag, so tell your human to restart it with ${LAUNCHER}. Never use pull: true here.`;

const GUARD_DOWN =
  "The mesh window's worktree guard did not run for this call, so this session can't take team work. Check that hooks are on (disableAllHooks) and that node is on PATH, then call activate again.";

const needDescription = () =>
  new MeshError(
    'invalid_request',
    'Pass description too: one line on what this session is working on.',
  );

/**
 * The mesh window's guard stamp (null for any other session). The guard stamps this very call;
 * without it, edits and commands here go unchecked, so the window refuses, and the version an
 * earlier activate recorded no longer stands (relays stop).
 */
function windowStamp(
  window: MeshWindowContext,
  activation: ActivationState,
): { version: string | null } | null {
  if (window.state !== 'verified') return null;
  const stamp = freshGuardStamp(window.dataDir, Date.now());
  if (stamp) return stamp;
  activation.guardVersion = null;
  throw new ToolRefusal(GUARD_DOWN);
}

/** Opting this session in and out of the mesh, and moving work to it. */
export const sessionTools = [
  defineTool({
    name: 'activate',
    description:
      'Turn this session on for the mesh, only when your human asks (/agentmesh:activate). Until then it receives nothing. pull: true activates it without pushes; use it only when the test message did not arrive (no channel flag, or Claude Desktop).',
    input: z.object({
      code: z.string().optional(),
      description: Description.optional(),
      pull: z.boolean().optional(),
    }),
    mutating: false,
    run: async (args, { hub, activation, listening, window, agentId, teamPolicy }) => {
      // Before any hub call: a marker that does not verify must not take team work.
      if (window.state === 'marked') {
        throw new ToolRefusal(
          `AGENTMESH_MESH_WINDOW is set, but it doesn't match ~/.agentmesh/mesh-window.json for ${agentId}, so this session can't be your mesh window. Start it with ${LAUNCHER}, or run /agentmesh:window again.`,
        );
      }
      const isWindow = window.state === 'verified';
      const stamp = windowStamp(window, activation);
      if (args.pull) {
        if (isWindow) throw new ToolRefusal(PULL_REFUSED);
        if (!args.description) throw needDescription();
        const view = await hub.call('session.activate', {
          mode: 'pull',
          description: args.description,
        });
        activation.lastDescription = view.description ?? args.description;
        activation.renewedFrom = null;
        activation.pull = true;
        return `This session is active on the mesh as “${activation.lastDescription}”, pull-only. ${PULL_ACTIVE} ${notWindow(window)}`;
      }
      if (args.code === undefined) {
        endRenewal(activation);
        // The hub sends the code over this session's subject; only the push shows it to Claude,
        // so getting it back proves both legs. In the first seconds nobody listens there yet;
        // if that never changes, the hub's failure says why.
        await Promise.race([listening, new Promise((r) => setTimeout(r, LISTEN_WAIT_MS))]);
        await hub.call('session.check', {});
        return isWindow ? WINDOW_CHECK_SENT : CHECK_SENT;
      }
      if (!args.description) throw needDescription();
      const params = { code: args.code, description: args.description };
      if (!(await activateSession(hub, activation, params, stamp))) {
        return 'This session was turned off while it activated, so it stays off; /agentmesh:activate turns it back on.';
      }
      const active = `This session is active on the mesh as “${activation.lastDescription}”.`;
      if (!isWindow) return `${active} ${notWindow(window)}`;
      // The instructions clip a long policy at 4096 characters; the window gets it whole here.
      const policy = teamPolicy();
      const full = policy ? `\n\nTeam policy (in full):\n${policy}` : '';
      return `${active} It is your mesh window.\n\n${windowRules(window.policy)}${full}`;
    },
  }),
  defineTool({
    name: 'deactivate',
    description:
      'Turn this session off for the mesh, when your human asks (/agentmesh:deactivate). It keeps the tools but receives nothing, and the work it owns is released.',
    input: z.object({}),
    mutating: false,
    run: async (_args, { hub, activation }) => {
      // Before the hub call: an activation still out (a renewal answering its check) then loses.
      activation.epoch += 1;
      activation.lastDescription = null;
      activation.renewedFrom = null;
      activation.pull = false;
      activation.guardVersion = null;
      await hub.call('session.deactivate', {});
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
