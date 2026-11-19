import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile, updateEnvFile } from './env-file';
import { renderCompose } from './render/deploy-files';
import { workspacePaths, writeRendered } from './workspace';

/**
 * The old names this file keeps on purpose, so a workspace made before the rename still works:
 * the state file, the `AGENTMESH_` keys, the compose project and the server folder.
 */
const OLD_STATE = '.agentmesh-setup.json';
const OLD_PREFIX = 'AGENTMESH_';
const OLD_PROJECT = 'agentmesh';
const OLD_REMOTE_DIR = '/opt/agentmesh';
const KEYS = ['CONFIG_DIR', 'LOG_LEVEL', 'IMAGE_REGISTRY', 'VERSION'];

/** Adds the COSMICWAVE_ keys and the compose project name; returns the line, or undefined. */
function convertEnv(envFile: string, env: Map<string, string>): string | undefined {
  const add: Record<string, string> = {};
  for (const k of KEYS) {
    const old = env.get(`${OLD_PREFIX}${k}`);
    if (old !== undefined && !env.has(`COSMICWAVE_${k}`)) add[`COSMICWAVE_${k}`] = old;
  }
  if (!env.has('COMPOSE_PROJECT_NAME')) add.COMPOSE_PROJECT_NAME = OLD_PROJECT;
  const keys = Object.keys(add);
  if (keys.length === 0) return undefined;
  updateEnvFile(envFile, add);
  return `Added ${keys.join(', ')} to deploy/.env`;
}

/** Pins a server's remoteDir to the folder it already uses; returns the line, or undefined. */
function convertAnswers(path: string): string | undefined {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    hosting?: { mode?: string; remoteDir?: string };
  };
  if (raw.hosting?.mode !== 'server' || raw.hosting.remoteDir !== undefined) return undefined;
  raw.hosting.remoteDir = OLD_REMOTE_DIR;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return 'Set hosting.remoteDir in setup-answers.json to the server folder it already uses';
}

/**
 * Converts a setup workspace made as AgentMesh, in place and once. Returns one line per change
 * (key names and file names, never values) and `[]` when there is nothing to do.
 */
export function convertLegacyWorkspace(root: string): string[] {
  const p = workspacePaths(root);
  const oldState = join(root, OLD_STATE);
  const env = existsSync(p.envFile) ? readEnvFile(p.envFile) : new Map<string, string>();
  const legacy =
    existsSync(oldState) || (env.has(`${OLD_PREFIX}VERSION`) && !env.has('COSMICWAVE_VERSION'));
  if (!legacy) return [];

  const lines: (string | undefined)[] = [];
  if (existsSync(oldState) && !existsSync(p.state)) {
    renameSync(oldState, p.state);
    lines.push(`Renamed ${OLD_STATE} to .cosmicwave-setup.json`);
  }
  if (existsSync(p.envFile)) lines.push(convertEnv(p.envFile, env));
  if (existsSync(p.answers)) lines.push(convertAnswers(p.answers));
  if (existsSync(p.compose) && writeRendered(p.compose, renderCompose(), true) === 'replaced') {
    lines.push('Rendered deploy/docker-compose.yml again');
  }
  return lines.filter((l): l is string => l !== undefined);
}
