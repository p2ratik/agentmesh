import { generateUserKey } from '@agentmesh/bus';
import { isMeshError } from '@agentmesh/common';
import { enroll, type Greeting } from './enroll';
import { assertCanJoin, type SavedEnrollment, saveConfig, stageSeed } from './files';
import { type InviteSummary, readInvite } from './invite';

export interface JoinRequest {
  code: string;
  home: string;
  clientVersion: string;
  /** The hub (`host:port`) the human confirmed; nothing connects until it matches. */
  confirmedHub?: string | undefined;
  /** Replace a mesh this laptop is already set up for. */
  replace: boolean;
}

export type JoinOutcome =
  | { kind: 'confirm'; summary: InviteSummary }
  | { kind: 'joined'; summary: InviteSummary; saved: SavedEnrollment; hello: Greeting };

/**
 * The whole join, shared by the `join` tool and `server.js join`: decode,
 * refuse to clobber another mesh, wait for the human to confirm the hub, then
 * enroll and save. A crafted invite could point at an attacker's hub that
 * injects messages with team trust, hence the confirmation step.
 */
export async function runJoin(request: JoinRequest): Promise<JoinOutcome> {
  const summary = readInvite(request.code);
  assertCanJoin(request.home, request.replace);
  if (request.confirmedHub?.trim() !== summary.hub) return { kind: 'confirm', summary };
  const { payload } = summary;
  const key = generateUserKey();
  // The seed is on disk before the invite is spent, and removed again if the hub refuses.
  const staged = stageSeed(request.home, payload.agentId, key.seed);
  let hello: Greeting;
  try {
    hello = await enroll(summary, request.code, key.seed, request.clientVersion);
  } catch (error) {
    // Only a clear refusal proves the hub did not enroll this key; otherwise keep it staged.
    if (!(isMeshError(error) && error.details?.mayBeEnrolled)) staged.discard();
    throw error;
  }
  const seedFile = staged.commit();
  const configFile = saveConfig(request.home, payload, seedFile);
  return { kind: 'joined', summary, saved: { seedFile, configFile }, hello };
}
