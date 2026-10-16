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

export type ConfigResult = { ok: true; config: PluginConfig } | { ok: false; problems: string[] };

/** ~/.agentmesh/agent.json — written by `agentmesh agent-setup --write`. */
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
 */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  file = DEFAULT_CONFIG_FILE,
): ConfigResult {
  const fromFile = readFileConfig(file);
  const pick = (key: string, fallback: string | undefined) => usable(env[key]) ?? usable(fallback);
  const agentId = pick('AGENTMESH_AGENT_ID', fromFile.agentId);
  const urls = pick('AGENTMESH_NATS_URL', fromFile.natsUrl);
  const prefix = pick('AGENTMESH_PREFIX', fromFile.prefix) ?? 'mesh';
  const seed = pick('AGENTMESH_NKEY_SEED', fromFile.nkeySeed);
  const heartbeat = Number(usable(env.AGENTMESH_HEARTBEAT_SECONDS) ?? 20);

  const problems: string[] = [];
  if (!agentId) problems.push('agent_id is not set');
  else if (!isValidParticipantId(agentId)) problems.push(`agent_id "${agentId}" is not a valid id`);
  if (!urls) problems.push('nats_url is not set');
  if (!PREFIX_PATTERN.test(prefix)) problems.push(`prefix "${prefix}" is not valid`);
  if (!Number.isFinite(heartbeat) || heartbeat < 5)
    problems.push('AGENTMESH_HEARTBEAT_SECONDS must be >= 5');
  if (problems.length > 0 || !agentId || !urls) return { ok: false, problems };

  const logFile = usable(env.AGENTMESH_LOG_FILE);
  return {
    ok: true,
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
