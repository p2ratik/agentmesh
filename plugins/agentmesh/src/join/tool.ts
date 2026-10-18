import { homedir } from 'node:os';
import { expandHome, isMeshError } from '@agentmesh/common';
import { z } from 'zod';
import { listTools, type ToolListing, type ToolResult } from '../tools/registry';
import { defaultInviteFile, deleteInviteFile, readInviteFile } from './files';
import { runJoin } from './flow';
import { confirmationText } from './invite';

export const JOIN_TOOL = 'join';

const JoinInput = z.object({
  invite_file: z
    .string()
    .optional()
    .describe(
      'File holding the invite code (default ~/.agentmesh/invite.txt). Never ask for the code itself.',
    ),
  confirm_hub: z
    .string()
    .optional()
    .describe('The hub host:port your human confirmed, exactly as the first join call showed it.'),
  replace: z.boolean().default(false).describe('Replace a mesh this laptop is already set up for.'),
});

/** Listed like the mesh tools, but it runs before there is a hub to call (see `callJoinTool`). */
export const joinToolListing = listTools([
  {
    name: JOIN_TOOL,
    description:
      'Join an AgentMesh with an invite. Your human saves the invite code from their Discord DM to ~/.agentmesh/invite.txt (never paste it into the chat). The first call shows which hub it points at; ask your human to confirm, then call again with confirm_hub.',
    input: JoinInput,
    mutating: true,
    run: async () => '',
  },
])[0] as ToolListing;

export interface JoinToolDeps {
  clientVersion: string;
  home?: string;
  /** Called once the laptop is enrolled and agent.json is written. */
  onJoined(agentId: string): Promise<void>;
}

/** The only tool an unenrolled plugin offers. The code is read from a file, never from the model. */
export async function callJoinTool(rawArgs: unknown, deps: JoinToolDeps): Promise<ToolResult> {
  const parsed = JoinInput.safeParse(rawArgs ?? {});
  if (!parsed.success) return text(`Invalid arguments for join: ${parsed.error.message}`, true);
  const home = deps.home ?? homedir();
  const file = parsed.data.invite_file
    ? expandHome(parsed.data.invite_file)
    : defaultInviteFile(home);
  try {
    const outcome = await runJoin({
      code: readInviteFile(file),
      home,
      clientVersion: deps.clientVersion,
      confirmedHub: parsed.data.confirm_hub,
      replace: parsed.data.replace,
    });
    if (outcome.kind === 'confirm') {
      return text(
        `${confirmationText(outcome.summary)}\nAsk your human whether ${outcome.summary.hub} is your team's hub. Only if they say yes, call join again with confirm_hub: "${outcome.summary.hub}".`,
      );
    }
    deleteInviteFile(file);
    await deps.onJoined(outcome.summary.payload.agentId);
    const { self, mesh } = outcome.hello;
    return text(
      `Joined the AgentMesh "${mesh.name}" as ${self.id}. Your key was generated on this laptop and saved to ${outcome.saved.seedFile}; settings are in ${outcome.saved.configFile}. The mesh tools are live now; call inbox. Restart Claude Code with the channel flag later to receive pushed messages if you are not already.`,
    );
  } catch (error) {
    return text(isMeshError(error) ? error.message : `join failed: ${String(error)}`, true);
  }
}

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}
