import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidParticipantId, mapLegacyPath, meshHome } from '@cosmicwave/common';
import { PREFIX_PATTERN } from '@cosmicwave/protocol';
import { z } from 'zod';
import { fileApplies, resolveAgentId, usable } from './agent-id';

export interface PluginConfig {
  agentId: string;
  servers: string[];
  /** Seed literal or path; absent for development servers without auth. */
  nkeySeed?: string;
  prefix: string;
  heartbeatSeconds: number;
  logFile?: string;
}

export type ConfigResult =
  /** `warnings`: settings that were overridden, for the log. */
  | { ok: true; config: PluginConfig; warnings?: string[] }
  /** `unenrolled`: neither agent_id nor nats_url is set anywhere, so `join` is the way in. */
  | { ok: false; problems: string[]; unenrolled: boolean; logFile?: string };

/** ~/.cosmicwave/agent.json — written by `join` and `cmw agent-setup --write`. */
const FileConfig = z.object({
  agentId: z.string().optional(),
  natsUrl: z.string().optional(),
  nkeySeed: z.string().optional(),
  prefix: z.string().optional(),
});
type FileConfig = z.infer<typeof FileConfig>;
type Env = Record<string, string | undefined>;

/** agent.json in `meshHome`: ~/.cosmicwave, or ~/.agentmesh on a laptop not moved yet. */
export const defaultConfigFile = (home?: string): string => join(meshHome(home), 'agent.json');

/**
 * Plugin `userConfig` values arrive as env vars. Unset values may show up as
 * empty strings or as the literal `${user_config.x}` placeholder, so both
 * count as unset and fall back to ~/.cosmicwave/agent.json, if that file is
 * for this agent (`fileApplies`). Its prefix wins over the option (`resolvePrefix`).
 */
export function resolveConfig(env: Env = process.env, file = defaultConfigFile()): ConfigResult {
  const saved = readFileConfig(file);
  const options = { agentId: env.COSMICWAVE_AGENT_ID, natsUrl: env.COSMICWAVE_NATS_URL };
  const fromFile = fileApplies(options, saved) ? saved : {};
  const pick = (key: string, fallback: string | undefined) => usable(env[key]) ?? usable(fallback);
  const agentId = resolveAgentId(options, saved) ?? undefined;
  const urls = pick('COSMICWAVE_NATS_URL', fromFile.natsUrl);
  const { prefix, warnings } = resolvePrefix(env, fromFile);
  const seed = pick('COSMICWAVE_NKEY_SEED', fromFile.nkeySeed);
  const heartbeat = Number(usable(env.COSMICWAVE_HEARTBEAT_SECONDS) ?? 20);
  const logFile = usable(env.COSMICWAVE_LOG_FILE);

  const problems = configProblems(agentId, urls, prefix, heartbeat);
  if (problems.length > 0 || !agentId || !urls) {
    return { ok: false, problems, unenrolled: !agentId && !urls, ...(logFile ? { logFile } : {}) };
  }

  return {
    ok: true,
    ...(warnings.length > 0 ? { warnings } : {}),
    config: {
      agentId,
      servers: urls
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      prefix,
      heartbeatSeconds: heartbeat,
      ...(seed ? { nkeySeed: seed } : {}),
      ...(logFile ? { logFile } : {}),
    },
  };
}

/**
 * agent.json's prefix wins: it comes from the hub (the invite, or the mesh
 * config for `agent-setup --write`), while the option may hold a value
 * Claude Code stored without the user choosing it. Pass `{}` when the file
 * does not apply.
 */
export function resolvePrefix(
  env: Env,
  fromFile: FileConfig,
): { prefix: string; warnings: string[] } {
  const option = usable(env.COSMICWAVE_PREFIX);
  const saved = usable(fromFile.prefix);
  const warnings =
    saved && option && saved !== option
      ? [`ignoring the prefix option "${option}": ~/.cosmicwave/agent.json sets "${saved}"`]
      : [];
  return { prefix: saved ?? option ?? 'mesh', warnings };
}

function configProblems(
  agentId: string | undefined,
  urls: string | undefined,
  prefix: string,
  heartbeat: number,
): string[] {
  const problems: string[] = [];
  if (!agentId) problems.push('agent_id is not set');
  else if (!isValidParticipantId(agentId)) problems.push(`agent_id "${agentId}" is not a valid id`);
  if (!urls) problems.push('nats_url is not set');
  if (!PREFIX_PATTERN.test(prefix)) problems.push(`prefix "${prefix}" is not valid`);
  if (!Number.isFinite(heartbeat) || heartbeat < 5)
    problems.push('COSMICWAVE_HEARTBEAT_SECONDS must be >= 5');
  return problems;
}

function readFileConfig(file: string): FileConfig {
  if (!existsSync(file)) return {};
  try {
    const parsed = FileConfig.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) return {};
    const { nkeySeed } = parsed.data;
    // A seed path into ~/.agentmesh that the move could not rewrite.
    return nkeySeed
      ? { ...parsed.data, nkeySeed: mapLegacyPath(nkeySeed, homedir()) }
      : parsed.data;
  } catch {
    return {};
  }
}
