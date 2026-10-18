import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import type { InvitePayload } from '@agentmesh/protocol';

export const agentmeshDir = (home = homedir()): string => join(home, '.agentmesh');

/** Where the human saves the invite from the Discord DM, so the code never enters the chat. */
export const defaultInviteFile = (home = homedir()): string =>
  join(agentmeshDir(home), 'invite.txt');

export function readInviteFile(path: string): string {
  if (!existsSync(path)) {
    throw new MeshError(
      'not_found',
      `No invite file at ${path}. Save the invite code from your Discord DM there first.`,
    );
  }
  return readFileSync(path, 'utf8');
}

/** The invite is single use; once redeemed, nothing should keep a copy around. */
export function deleteInviteFile(path: string): void {
  rmSync(path, { force: true });
}

/** The mesh this laptop is already set up for, if any (`~/.agentmesh/agent.json`). */
export function existingMesh(home = homedir()): { agentId?: string; natsUrl?: string } | null {
  const file = join(agentmeshDir(home), 'agent.json');
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const pick = (k: string) => (typeof value[k] === 'string' ? (value[k] as string) : undefined);
    const agentId = pick('agentId');
    const natsUrl = pick('natsUrl');
    return agentId || natsUrl
      ? { ...(agentId ? { agentId } : {}), ...(natsUrl ? { natsUrl } : {}) }
      : null;
  } catch {
    return null;
  }
}

/** Refuses to replace another mesh's setup unless asked to. */
export function assertCanJoin(home: string, replace: boolean): void {
  const current = existingMesh(home);
  if (current && !replace) {
    throw new MeshError(
      'conflict',
      `This laptop is already set up as ${current.agentId ?? 'an agent'} on ${current.natsUrl ?? 'a mesh'} (~/.agentmesh/agent.json). Join again with replace to switch meshes.`,
    );
  }
}

/** Owner-only file (mode 600; on Windows the user profile's ACL protects it). */
function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some network filesystems have no POSIX modes.
  }
}

export interface SavedEnrollment {
  configFile: string;
  seedFile: string;
}

/**
 * Saves the new key and the connection settings the plugin reads at start.
 * The seed goes in its own file; agent.json only points at it.
 */
export function saveEnrollment(
  home: string,
  payload: InvitePayload,
  seed: string,
): SavedEnrollment {
  const dir = agentmeshDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seedFile = join(dir, `${payload.agentId}.nk`);
  const configFile = join(dir, 'agent.json');
  writePrivate(seedFile, `${seed}\n`);
  const config = {
    agentId: payload.agentId,
    natsUrl: payload.natsUrl,
    nkeySeed: seedFile,
    prefix: payload.prefix,
  };
  writePrivate(configFile, `${JSON.stringify(config, null, 2)}\n`);
  return { configFile, seedFile };
}
