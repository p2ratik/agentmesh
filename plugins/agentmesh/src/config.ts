import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidParticipantId } from '@agentmesh/common';
import { PREFIX_PATTERN } from '@agentmesh/protocol';
import { z } from 'zod';

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

/** ~/.agentmesh/agent.json — written by `join` and `agentmesh agent-setup --write`. */
const FileConfig = z.object({
  agentId: z.string().optional(),
  natsUrl: z.string().optional(),
  nkeySeed: z.string().optional(),
  prefix: z.string().optional(),
});

export const DEFAULT_CONFIG_FILE = join(homedir(), '.agentmesh', 'agent.json');

/**
 * Plugin `userConfig` values arrive as env vars. Unset values may show up as
 * empty strings or as the literal `${user_config.x}` placeholder, so both
 * count as unset and fall back to ~/.agentmesh/agent.json.
 *
 * The prefix is the exception: when agent.json describes the hub in use (the
 * nats_url option is unset or the same), agent.json's prefix wins. It comes
 * from that hub (the invite, or the mesh config for `agent-setup --write`),
 * while the option may hold a value Claude Code stored without the user
 * choosing it. An option pointing at another hub keeps its own prefix.
 */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  file = DEFAULT_CONFIG_FILE,
): ConfigResult {
  const fromFile = readFileConfig(file);
  const pick = (key: string, fallback: string | undefined) => usable(env[key]) ?? usable(fallback);
  const agentId = pick('AGENTMESH_AGENT_ID', fromFile.agentId);
  const envUrls = usable(env.AGENTMESH_NATS_URL);
  const fileUrls = usable(fromFile.natsUrl);
  const urls = envUrls ?? fileUrls;
  const envPrefix = usable(env.AGENTMESH_PREFIX);
  const filePrefix = usable(fromFile.prefix);
  const fileIsThisHub = fileUrls !== undefined && (envUrls === undefined || envUrls === fileUrls);
  const prefix = (fileIsThisHub ? (filePrefix ?? envPrefix) : (envPrefix ?? filePrefix)) ?? 'mesh';
  const seed = pick('AGENTMESH_NKEY_SEED', fromFile.nkeySeed);
  const heartbeat = Number(usable(env.AGENTMESH_HEARTBEAT_SECONDS) ?? 20);
  const logFile = usable(env.AGENTMESH_LOG_FILE);
  const warnings =
    fileIsThisHub && filePrefix && envPrefix && filePrefix !== envPrefix
      ? [`ignoring the prefix option "${envPrefix}": ~/.agentmesh/agent.json sets "${filePrefix}"`]
      : [];

  const problems: string[] = [];
  if (!agentId) problems.push('agent_id is not set');
  else if (!isValidParticipantId(agentId)) problems.push(`agent_id "${agentId}" is not a valid id`);
  if (!urls) problems.push('nats_url is not set');
  if (!PREFIX_PATTERN.test(prefix)) problems.push(`prefix "${prefix}" is not valid`);
  if (!Number.isFinite(heartbeat) || heartbeat < 5)
    problems.push('AGENTMESH_HEARTBEAT_SECONDS must be >= 5');
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

function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('${')) return undefined;
  return trimmed;
}

function readFileConfig(file: string): z.infer<typeof FileConfig> {
  if (!existsSync(file)) return {};
  try {
    const parsed = FileConfig.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
