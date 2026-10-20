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
type FileConfig = z.infer<typeof FileConfig>;
type Env = Record<string, string | undefined>;

export const DEFAULT_CONFIG_FILE = join(homedir(), '.agentmesh', 'agent.json');

/**
 * Plugin `userConfig` values arrive as env vars. Unset values may show up as
 * empty strings or as the literal `${user_config.x}` placeholder, so both
 * count as unset and fall back to ~/.agentmesh/agent.json, if that file is
 * for this agent (`fileApplies`). Its prefix wins over the option (`resolvePrefix`).
 */
export function resolveConfig(env: Env = process.env, file = DEFAULT_CONFIG_FILE): ConfigResult {
  const saved = readFileConfig(file);
  const fromFile = fileApplies(env, saved) ? saved : {};
  const pick = (key: string, fallback: string | undefined) => usable(env[key]) ?? usable(fallback);
  const agentId = pick('AGENTMESH_AGENT_ID', fromFile.agentId);
  const urls = pick('AGENTMESH_NATS_URL', fromFile.natsUrl);
  const { prefix, warnings } = resolvePrefix(env, fromFile);
  const seed = pick('AGENTMESH_NKEY_SEED', fromFile.nkeySeed);
  const heartbeat = Number(usable(env.AGENTMESH_HEARTBEAT_SECONDS) ?? 20);
  const logFile = usable(env.AGENTMESH_LOG_FILE);

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
 * agent.json is for this agent unless the options name another agent or hub.
 * A field the file lacks never conflicts (hand-written files may hold only a
 * seed). One file serves every Claude account on the laptop, so another
 * account's options must not pick up this file's prefix or seed.
 */
export function fileApplies(env: Env, saved: FileConfig): boolean {
  const agrees = (option: string | undefined, value: string | undefined) => {
    const a = usable(option);
    const b = usable(value);
    return a === undefined || b === undefined || a === b;
  };
  return (
    agrees(env.AGENTMESH_AGENT_ID, saved.agentId) && agrees(env.AGENTMESH_NATS_URL, saved.natsUrl)
  );
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
  const option = usable(env.AGENTMESH_PREFIX);
  const saved = usable(fromFile.prefix);
  const warnings =
    saved && option && saved !== option
      ? [`ignoring the prefix option "${option}": ~/.agentmesh/agent.json sets "${saved}"`]
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
    problems.push('AGENTMESH_HEARTBEAT_SECONDS must be >= 5');
  return problems;
}

function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('${')) return undefined;
  return trimmed;
}

function readFileConfig(file: string): FileConfig {
  if (!existsSync(file)) return {};
  try {
    const parsed = FileConfig.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
