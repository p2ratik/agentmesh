import { randomUUID } from 'node:crypto';
import { isMeshError } from '@agentmesh/common';
import { z } from 'zod';
import { leaseTools } from './leases';
import { messagingTools } from './messaging';
import { planningTools } from './planning';
import { taskTools } from './tasks';
import type { ToolDef, ToolDeps } from './types';

export const ALL_TOOLS: readonly ToolDef[] = [
  ...messagingTools,
  ...taskTools,
  ...planningTools,
  ...leaseTools,
] as readonly ToolDef[];

export interface ToolListing {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** MCP `tools/list` entries; JSON Schema generated from the zod inputs. */
export function listTools(tools: readonly ToolDef[] = ALL_TOOLS): ToolListing[] {
  return tools.map((tool) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<
      string,
      unknown
    >;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: { ...schema, type: 'object' },
    };
  });
}

/**
 * Runs a tool and turns every failure into a readable `isError` result:
 * bad arguments list the issues, hub errors keep their code, a missing setup
 * returns the setup problem.
 */
export async function callTool(
  name: string,
  rawArgs: unknown,
  deps: ToolDeps | { problems: string[] },
  tools: readonly ToolDef[] = ALL_TOOLS,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return error(`Unknown tool "${name}".`);
  if ('problems' in deps) {
    return error(
      `AgentMesh is not configured: ${deps.problems.join('; ')}. Ask your human to finish the plugin setup.`,
    );
  }
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`);
    return error(`Invalid arguments for ${name}:\n${issues.join('\n')}`);
  }
  try {
    const text = await tool.run(parsed.data, deps, tool.mutating ? randomUUID() : undefined);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (isMeshError(err)) {
      const issues = Array.isArray(err.details?.issues)
        ? `\n${JSON.stringify(err.details.issues)}`
        : '';
      return error(`${err.code}: ${err.message}${issues}`);
    }
    return error(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The mesh tools against the hub, or each one reporting the setup problem. */
export function meshToolHandler(deps: ToolDeps | { problems: string[] }) {
  return {
    list: () => listTools(),
    call: (name: string, args: unknown) => callTool(name, args, deps),
  };
}

function error(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
