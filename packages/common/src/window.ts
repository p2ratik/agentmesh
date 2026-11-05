// The mesh window's files, policy and marker. Built-ins only (node:*): the plugin's hook and
// guard bundles import this and must stay free of zod and other dependencies.
import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const MESH_WINDOW_ENV = 'AGENTMESH_MESH_WINDOW';
export const MESH_WINDOW_HINT_ENV = 'AGENTMESH_MESH_WINDOW_HINT';
export const CHANNEL_FLAG = '--dangerously-load-development-channels plugin:agentmesh@agentmesh';
export const RESTART = `claude ${CHANNEL_FLAG}`;
export const LAUNCH_PROMPT: string | null = '/agentmesh:activate mesh window';
const launcherName = (platform: NodeJS.Platform) =>
  platform === 'win32' ? 'mesh-window.cmd' : 'mesh-window';
/**
 * The command that starts the mesh window: `window init` puts it on PATH (or says which folder to
 * add). cmd and PowerShell find its `.cmd`, Git Bash and other shells its sh script.
 */
export const START_COMMAND = 'claude-mesh';
/** The launcher in the fallback start line. PowerShell and Git Bash on Windows need the `.cmd`. */
export const launcherDisplay = (platform: NodeJS.Platform): string =>
  `~/.agentmesh/${launcherName(platform)}`;
/** The Windows launcher as cmd, which knows no `~`, runs it. */
export const LAUNCHER_CMD = '"%USERPROFILE%\\.agentmesh\\mesh-window.cmd"';

export interface WindowFiles {
  dir: string;
  policy: string;
  settings: string;
  launcher: string;
  emptyHooks: string;
  /** Where `claude-mesh` goes when it can't go next to `claude`. */
  bin: string;
}

export function windowFiles(home: string, platform: NodeJS.Platform): WindowFiles {
  // The given platform's separator, not the host's: a win32 launcher can be rendered on Linux (CI).
  const { join } = platform === 'win32' ? win32 : posix;
  const dir = join(home, '.agentmesh');
  return {
    dir,
    policy: join(dir, 'mesh-window.json'),
    settings: join(dir, 'mesh-window.settings.json'),
    launcher: join(dir, launcherName(platform)),
    emptyHooks: join(dir, 'empty-git-hooks'),
    bin: join(dir, 'bin'),
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

/** An own-branch prefix ends in `/`, `_` or `.`: ids may contain `-`, so `pratik-` would also
 * prefix teammate `pratik-2`'s branches. */
const endsAsPrefix = (v: string) => /[/_.]$/.test(v);

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
  const prefixOk = typeof prefix === 'string' && isBranchName(prefix) && endsAsPrefix(prefix);
  if (prefix !== null && !prefixOk) return null;
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

/**
 * The branch template up to its first placeholder other than {owner} and {agent}, with those
 * filled in. Null when that head names neither the owner nor the agent, or doesn't end as a
 * prefix must (`endsAsPrefix`).
 */
export function ownBranchPrefix(template: string, owner: string, agent: string): string | null {
  const cut = template.search(/{(?!owner}|agent})[^}]*}/);
  const head = cut < 0 ? template : template.slice(0, cut);
  if (!/{(owner|agent)}/.test(head)) return null;
  const filled = head.replaceAll('{owner}', owner).replaceAll('{agent}', agent);
  return endsAsPrefix(filled) ? filled : null;
}

export type MarkerState = 'none' | 'marked' | 'verified';

type Marker = { state: MarkerState; policy: WindowPolicy | null };

/** The window's policy file, parsed; null when it is missing, unreadable or invalid. */
export function readWindowPolicy(home: string, platform: NodeJS.Platform): WindowPolicy | null {
  try {
    return parseWindowPolicy(readFileSync(windowFiles(home, platform).policy, 'utf8'));
  } catch {
    return null;
  }
}

/** What the marker in `env` makes of the policy already read: verified only with its token. */
export function markerState(
  env: Record<string, string | undefined>,
  policy: WindowPolicy | null,
  agentId?: string,
): Marker {
  const value = env[MESH_WINDOW_ENV];
  if (!value) return { state: 'none', policy: null };
  if (policy && policy.token === value && (agentId === undefined || policy.agentId === agentId)) {
    return { state: 'verified', policy };
  }
  return { state: 'marked', policy: null };
}

/** The marker and its policy. An unmarked session (most guard and hook calls) skips the file. */
export function readMarker(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
  agentId?: string,
): Marker {
  if (!env[MESH_WINDOW_ENV]) return { state: 'none', policy: null };
  return markerState(env, readWindowPolicy(home, platform), agentId);
}
