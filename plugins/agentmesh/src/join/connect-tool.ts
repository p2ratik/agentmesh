import { z } from 'zod';
import type { ConfigResult } from '../config';
import { listTools, type ToolListing, type ToolResult } from '../tools/registry';

export const CONNECT_TOOL = 'connect';

/** Listed next to `join` while the plugin is unenrolled; it takes no arguments. */
export const connectToolListing = listTools([
  {
    name: CONNECT_TOOL,
    description:
      'Connect this session with the settings that agentmesh setup saved in ~/.agentmesh/agent.json.',
    input: z.object({}),
    mutating: true,
    run: async () => '',
  },
])[0] as ToolListing;

export interface ConnectToolDeps {
  /** Reads the settings again; `agentmesh setup admin` wrote them after this session started. */
  resolve(): ConfigResult;
  /** Opens the session and swaps in the mesh tools (the same switch `join` makes). */
  onConnected(agentId: string): Promise<void>;
}

/** Connects without a restart once `agentmesh setup admin` saved agent.json. */
export async function callConnectTool(deps: ConnectToolDeps): Promise<ToolResult> {
  const resolved = deps.resolve();
  if (!resolved.ok) {
    return text(
      `The saved AgentMesh settings do not load: ${resolved.problems.join('; ')}. Run agentmesh setup admin first.`,
      true,
    );
  }
  try {
    await deps.onConnected(resolved.config.agentId);
  } catch (error) {
    return text(`connect failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  return text(`Connected as ${resolved.config.agentId}. Run /agentmesh:activate.`);
}

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}
