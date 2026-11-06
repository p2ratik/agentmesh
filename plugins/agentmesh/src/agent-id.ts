// Built-ins only (the hook bundle imports this): which agent this plugin is, by the one rule the
// MCP server uses too (`resolveConfig`): the option, else ~/.agentmesh/agent.json when it applies.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** ~/.agentmesh/agent.json; the zod schema for the server's reader lives in config.ts. */
export interface SavedAgent {
  agentId?: string;
  natsUrl?: string;
  nkeySeed?: string;
  prefix?: string;
}

export interface AgentOptions {
  agentId?: string;
  natsUrl?: string;
}

/** An option value that is set: trimmed, not empty and not an unexpanded `${…}` placeholder. */
export function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('${')) return undefined;
  return trimmed;
}

/**
 * agent.json is for this agent unless the options name another agent or hub. A field the file
 * lacks never conflicts (hand-written files may hold only a seed).
 */
export function fileApplies(options: AgentOptions, saved: SavedAgent): boolean {
  const agrees = (option: string | undefined, value: string | undefined) => {
    const a = usable(option);
    const b = usable(value);
    return a === undefined || b === undefined || a === b;
  };
  return agrees(options.agentId, saved.agentId) && agrees(options.natsUrl, saved.natsUrl);
}

/** The agent id: the option, else the saved file's when it applies; null when neither names one. */
export function resolveAgentId(options: AgentOptions, saved: SavedAgent | null): string | null {
  const file = saved && fileApplies(options, saved) ? saved : {};
  return usable(options.agentId) ?? usable(file.agentId) ?? null;
}

const FIELDS = ['agentId', 'natsUrl', 'nkeySeed', 'prefix'] as const;

/** The same shape check as the server's zod schema: a plain object, string-or-absent fields. */
export function parseSavedAgent(value: unknown): SavedAgent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const saved: SavedAgent = {};
  for (const key of FIELDS) {
    const v = record[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') return null;
    saved[key] = v;
  }
  return saved;
}

/** This plugin's agent as the hook sees it; the hook gets the options as CLAUDE_PLUGIN_OPTION_*. */
export function hookAgentId(env: Record<string, string | undefined>, home: string): string | null {
  let saved: SavedAgent | null = null;
  try {
    saved = parseSavedAgent(
      JSON.parse(readFileSync(join(home, '.agentmesh', 'agent.json'), 'utf8')),
    );
  } catch {
    // no file, or not JSON: the options alone decide
  }
  return resolveAgentId(
    { agentId: env.CLAUDE_PLUGIN_OPTION_AGENT_ID, natsUrl: env.CLAUDE_PLUGIN_OPTION_NATS_URL },
    saved ?? {},
  );
}
