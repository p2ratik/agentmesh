// The mesh window's files, policy and marker. Built-ins only (node:*): the plugin's hook and
// guard bundles import this and must stay free of zod and other dependencies.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MESH_WINDOW_ENV = 'AGENTMESH_MESH_WINDOW';
export const MESH_WINDOW_HINT_ENV = 'AGENTMESH_MESH_WINDOW_HINT';
export const CHANNEL_FLAG = '--dangerously-load-development-channels plugin:agentmesh@agentmesh';
export const RESTART = `claude ${CHANNEL_FLAG}`;
export const LAUNCH_PROMPT: string | null = '/agentmesh:activate mesh window';
export const LAUNCHER_DISPLAY = '~/.agentmesh/mesh-window';

export interface WindowFiles {
  dir: string;
  policy: string;
  settings: string;
  launcher: string;
  emptyHooks: string;
}

export function windowFiles(home: string, platform: NodeJS.Platform): WindowFiles {
  const dir = join(home, '.agentmesh');
  return {
    dir,
    policy: join(dir, 'mesh-window.json'),
    settings: join(dir, 'mesh-window.settings.json'),
    launcher: join(dir, platform === 'win32' ? 'mesh-window.cmd' : 'mesh-window'),
    emptyHooks: join(dir, 'empty-git-hooks'),
  };
}

export interface WindowPolicy {
  version: 1;
  agentId: string;
  token: string;
  ownBranchPrefix: string | null;
  integrationBranch: string;
  testCommands: string[];
}

export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
// Copied from ids.ts (PARTICIPANT_ID_PATTERN) so this module imports nothing but node:*.
const PARTICIPANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_TEST_COMMANDS = 10;

export function isBranchName(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(v) && !v.includes('..');
}

export function isTestCommand(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._:/=@-]{0,199}$/.test(v) && !v.includes('  ') && !v.endsWith(' ');
}

export function parseWindowPolicy(text: string): WindowPolicy | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Record<string, unknown>;
  const { agentId, token, ownBranchPrefix: prefix, integrationBranch, testCommands } = p;
  if (p.version !== 1) return null;
  if (typeof agentId !== 'string' || !PARTICIPANT_PATTERN.test(agentId)) return null;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  if (prefix !== null && !(typeof prefix === 'string' && isBranchName(prefix))) return null;
  if (typeof integrationBranch !== 'string' || !isBranchName(integrationBranch)) return null;
  if (
    !Array.isArray(testCommands) ||
    testCommands.length > MAX_TEST_COMMANDS ||
    !testCommands.every((c) => typeof c === 'string' && isTestCommand(c))
  ) {
    return null;
  }
  return { version: 1, agentId, token, ownBranchPrefix: prefix, integrationBranch, testCommands };
}

/** The fixed start of the branch template, up to its first {task} or {slug}; null if empty. */
export function ownBranchPrefix(template: string, owner: string, agent: string): string | null {
  const cut = template.search(/\{(task|slug)\}/);
  const head = (cut < 0 ? template : template.slice(0, cut))
    .replaceAll('{owner}', owner)
    .replaceAll('{agent}', agent);
  return head === '' || head.includes('{') ? null : head;
}

export type MarkerState = 'none' | 'marked' | 'verified';

export function readMarker(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
  agentId?: string,
): { state: MarkerState; policy: WindowPolicy | null } {
  const value = env[MESH_WINDOW_ENV];
  if (!value) return { state: 'none', policy: null };
  let policy: WindowPolicy | null = null;
  try {
    policy = parseWindowPolicy(readFileSync(windowFiles(home, platform).policy, 'utf8'));
  } catch {
    // missing or unreadable: the window is marked but cannot be verified
  }
  if (policy && policy.token === value && (agentId === undefined || policy.agentId === agentId)) {
    return { state: 'verified', policy };
  }
  return { state: 'marked', policy: null };
}
