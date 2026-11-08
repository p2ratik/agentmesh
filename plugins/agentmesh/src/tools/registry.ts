import { randomUUID } from 'node:crypto';
import { isMeshError } from '@agentmesh/common';
import { z } from 'zod';
import { formatFyi, seenIds } from '../inbox/fyi';
import { recordShown, recordTool } from '../telemetry/plugin-events';
import { leaseTools } from './leases';
import { messagingTools } from './messaging';
import { observeTools } from './observe';
import { planningTools } from './planning';
import { sessionTools } from './sessions';
import { taskTools } from './tasks';
import { type ToolDef, type ToolDeps, ToolRefusal } from './types';

export const ALL_TOOLS: readonly ToolDef[] = [
  ...messagingTools,
  ...taskTools,
  ...planningTools,
  ...leaseTools,
  ...sessionTools,
  ...observeTools,
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
 * returns the setup problem. Buffered FYIs end the result and are reported
 * seen (`messages.seen` is no tool, so this never recurses).
 */
export async function callTool(
  name: string,
  rawArgs: unknown,
  deps: ToolDeps | { problems: string[] },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) return error(`Unknown tool "${name}".`);
  if ('problems' in deps) {
    return error(
      `AgentMesh is not configured: ${deps.problems.join('; ')}. Ask your human to finish the plugin setup.`,
    );
  }
  const result = await callConfigured(tool, rawArgs, deps);
  // A cancelled call still runs to the end, but Claude never sees its result: keep the FYIs.
  if (signal?.aborted) return result;
  for (const notice of deps.notices.splice(0)) result.content.push({ type: 'text', text: notice });
  const fyi = deps.fyi.take();
  if (fyi.items.length > 0) {
    result.content.push({ type: 'text', text: formatFyi(fyi) });
    deps.hub.reportSeen(seenIds(fyi));
    recordShown(deps.recorder, deps.hub.sessionId, fyi);
  }
  return result;
}

/** Validates the arguments and runs the tool; the result ends with this call's hub notes. */
async function callConfigured(
  tool: ToolDef,
  rawArgs: unknown,
  deps: ToolDeps,
): Promise<ToolResult> {
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`);
    return error(`Invalid arguments for ${tool.name}:\n${issues.join('\n')}`);
  }
  // Only this call's hub notes end its result, never those of parallel calls or background hellos.
  const notes: string[] = [];
  const hub: ToolDeps['hub'] = {
    get sessionId() {
      return deps.hub.sessionId;
    },
    call: (method, params, options) => deps.hub.call(method, params, options, notes),
    reportSeen: (ids) => deps.hub.reportSeen(ids),
  };
  const result = await run(tool, parsed.data, { ...deps, hub });
  if (notes.length > 0) result.content.push({ type: 'text', text: notes.join('\n') });
  return result;
}

/** A tool call's recorded outcome for a failure: its refusal, its hub error code, or a crash. */
const outcomeOf = (err: unknown): string =>
  err instanceof ToolRefusal ? 'refused' : isMeshError(err) ? err.code : 'internal';

async function run(tool: ToolDef, args: unknown, deps: ToolDeps): Promise<ToolResult> {
  const started = Date.now();
  const done = (outcome: string) => recordTool(deps, tool.name, args, outcome, started);
  let result: ToolResult;
  try {
    const text = await tool.run(args, deps, tool.mutating ? randomUUID() : undefined);
    result = { content: [{ type: 'text', text }] };
  } catch (err) {
    done(outcomeOf(err));
    if (err instanceof ToolRefusal) return error(err.message);
    if (isMeshError(err)) {
      const issues = Array.isArray(err.details?.issues)
        ? `\n${JSON.stringify(err.details.issues)}`
        : '';
      return error(`${err.code}: ${err.message}${issues}`);
    }
    return error(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  done('ok');
  return result;
}

/** The mesh tools against the hub, or each one reporting the setup problem. */
export function meshToolHandler(deps: ToolDeps | { problems: string[] }) {
  return {
    list: () => listTools(),
    call: (name: string, args: unknown, signal?: AbortSignal) => callTool(name, args, deps, signal),
  };
}

function error(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
