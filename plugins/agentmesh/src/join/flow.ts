import type { RpcResult } from '@agentmesh/protocol';
import { enroll } from './enroll';
import { assertCanJoin, type SavedEnrollment, saveEnrollment } from './files';
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
  | {
      kind: 'joined';
      summary: InviteSummary;
      saved: SavedEnrollment;
      hello: RpcResult<'session.hello'>;
    };

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
  const enrolled = await enroll(summary, request.code, request.clientVersion);
  const saved = saveEnrollment(request.home, summary.payload, enrolled.seed);
  return { kind: 'joined', summary, saved, hello: enrolled.hello };
}
