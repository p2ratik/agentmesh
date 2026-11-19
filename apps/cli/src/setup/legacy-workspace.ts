import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from '@cosmicwave/common';
import { writeFileWithDirs } from '../lib/files';
import { readEnvFile, updateEnvFile } from './env-file';
import { renderCompose } from './render/deploy-files';

/**
 * The old names this file keeps on purpose, so a workspace made before the rename still works:
 * the state file, the `AGENTMESH_` keys, the compose project and the server folder.
 *
 * This file must not import `workspace.ts` (which calls it).
 */
const OLD_STATE = '.agentmesh-setup.json';
const NEW_STATE = '.cosmicwave-setup.json';
const OLD_PREFIX = 'AGENTMESH_';
const OLD_PROJECT = 'agentmesh';
const OLD_REMOTE_DIR = '/opt/agentmesh';
const KEYS = ['CONFIG_DIR', 'LOG_LEVEL', 'IMAGE_REGISTRY'];

/** Writes a value so `parseEnv` reads it back identical (quotes, ` #`, edge spaces). */
function envLiteral(value: string): string {
  if (!/^["']|^\s|\s$|\s#/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  // Both quote kinds: no quoting reads back identical, so it is written bare.
  return value;
}

/** Copies the old keys the new compose file reads; returns the key names it added. */
function copyKeys(env: Map<string, string>, keys: string[]): Record<string, string> {
  const add: Record<string, string> = {};
  for (const k of keys) {
    const old = env.get(`${OLD_PREFIX}${k}`);
    if (old !== undefined && !env.has(`COSMICWAVE_${k}`)) add[`COSMICWAVE_${k}`] = envLiteral(old);
  }
  return add;
}

function addToEnv(envFile: string, add: Record<string, string>, lines: string[]): void {
  const keys = Object.keys(add);
  if (keys.length === 0) return;
  updateEnvFile(envFile, add);
  lines.push(`Added ${keys.join(', ')} to deploy/.env`);
}

/** Pins a server's remoteDir to the folder it already uses; returns the line, if it changed. */
function pinRemoteDir(path: string): string | undefined {
  let raw: { hosting?: { mode?: string; remoteDir?: string } } | null;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new MeshError('invalid_request', `${path} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  if (raw?.hosting?.mode !== 'server' || raw.hosting.remoteDir !== undefined) return undefined;
  raw.hosting.remoteDir = OLD_REMOTE_DIR;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return 'Set hosting.remoteDir in setup-answers.json to the server folder it already uses';
}

/**
 * Converts a setup workspace made as AgentMesh, in place and once. Returns one line per change
 * (key names and file names, never values) and `[]` when there is nothing to do.
 *
 * The two markers that make a workspace "not legacy" (`COSMICWAVE_VERSION` and the state file
 * under its new name) are written last, so a step that fails leaves the workspace legacy and the
 * next run finishes the job. Every step is idempotent.
 */
export function convertLegacyWorkspace(root: string): string[] {
  const envFile = join(root, 'deploy', '.env');
  const answers = join(root, 'setup-answers.json');
  const compose = join(root, 'deploy', 'docker-compose.yml');
  const oldState = join(root, OLD_STATE);
  const newState = join(root, NEW_STATE);
  const env = existsSync(envFile) ? readEnvFile(envFile) : new Map<string, string>();
  const legacy =
    existsSync(oldState) || (env.has(`${OLD_PREFIX}VERSION`) && !env.has('COSMICWAVE_VERSION'));
  if (!legacy) return [];

  const lines: string[] = [];
  if (existsSync(answers)) {
    const pinned = pinRemoteDir(answers);
    if (pinned) lines.push(pinned);
  }
  if (existsSync(compose)) {
    const next = renderCompose();
    if (readFileSync(compose, 'utf8') !== next) {
      writeFileWithDirs(compose, next);
      lines.push('Rendered deploy/docker-compose.yml again');
    }
  }
  if (existsSync(envFile)) {
    const add = copyKeys(env, KEYS);
    if (!env.has('COMPOSE_PROJECT_NAME')) add.COMPOSE_PROJECT_NAME = OLD_PROJECT;
    addToEnv(envFile, add, lines);
    addToEnv(envFile, copyKeys(env, ['VERSION']), lines);
  }
  if (existsSync(oldState) && !existsSync(newState)) {
    renameSync(oldState, newState);
    lines.push(`Renamed ${OLD_STATE} to ${NEW_STATE}`);
  }
  return lines;
}
