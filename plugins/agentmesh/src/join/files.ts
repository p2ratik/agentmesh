import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentmeshDir, existingMesh, MeshError } from '@agentmesh/common';
import type { InvitePayload } from '@agentmesh/protocol';

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
 * Writes the new seed next to its final place before anything connects, so
 * a laptop that cannot save it never spends the single-use invite.
 * `commit` moves it into place; `discard` removes it after a refusal.
 */
export function stageSeed(
  home: string,
  agentId: string,
  seed: string,
): { commit(): string; discard(): void } {
  const dir = agentmeshDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seedFile = join(dir, `${agentId}.nk`);
  const staged = `${seedFile}.joining`;
  writePrivate(staged, `${seed}\n`);
  return {
    commit: () => {
      renameSync(staged, seedFile);
      return seedFile;
    },
    discard: () => rmSync(staged, { force: true }),
  };
}

/** The connection settings the plugin reads at start; agent.json only points at the seed file. */
export function saveConfig(home: string, payload: InvitePayload, seedFile: string): string {
  const configFile = join(agentmeshDir(home), 'agent.json');
  const config = {
    agentId: payload.agentId,
    natsUrl: payload.natsUrl,
    nkeySeed: seedFile,
    prefix: payload.prefix,
  };
  writePrivate(configFile, `${JSON.stringify(config, null, 2)}\n`);
  return configFile;
}

/** Seed and settings in one go (tests, and setups that already hold a key). */
export function saveEnrollment(
  home: string,
  payload: InvitePayload,
  seed: string,
): SavedEnrollment {
  const seedFile = stageSeed(home, payload.agentId, seed).commit();
  return { seedFile, configFile: saveConfig(home, payload, seedFile) };
}
