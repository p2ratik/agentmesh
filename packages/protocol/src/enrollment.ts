import { MeshError } from '@agentmesh/common';
import { z } from 'zod';
import { IsoDate, ParticipantId } from './primitives';

/** NATS user public key (starts with U). Public keys are safe to store and show. */
export const PublicNkey = z.string().regex(/^U[A-Z2-7]{55}$/, 'a NATS user public key (U…)');

export const DiscordUserId = z.string().regex(/^\d{5,25}$/, 'a Discord user id');

export const InviteId = z.string().regex(/^inv-[0-9A-Za-z]{1,40}$/, 'an invite id (inv-…)');

/** What an invite code carries: where to connect, which invite, and its one-time secret. */
export const InvitePayload = z.object({
  v: z.literal(1),
  natsUrl: z.url({ protocol: /^(nats|tls|ws|wss)$/, error: 'a nats://, tls:// or wss:// URL' }),
  inviteId: InviteId,
  /** 32 random bytes, base64url. The hub stores only its sha256. */
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/, '32 bytes, base64url'),
});
export type InvitePayload = z.infer<typeof InvitePayload>;

/** Real codes are ~200 chars; anything far longer is not worth parsing. */
const MAX_INVITE_CODE_CHARS = 1024;

/** The single string a new member pastes into `/agentmesh:join`. */
export function encodeInvite(payload: InvitePayload): string {
  return Buffer.from(JSON.stringify(InvitePayload.parse(payload))).toString('base64url');
}

export function decodeInvite(code: string): InvitePayload {
  const trimmed = code.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INVITE_CODE_CHARS) throw invalidInvite();
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(trimmed, 'base64url').toString('utf8'));
  } catch {
    throw invalidInvite();
  }
  const parsed = InvitePayload.safeParse(json);
  if (!parsed.success) throw invalidInvite();
  return parsed.data;
}

// Never echo the code: it is a bearer secret.
const invalidInvite = () => new MeshError('invalid_request', 'Not a valid AgentMesh invite code');

export const MemberStatus = z.enum(['active', 'revoked']);
export type MemberStatus = z.infer<typeof MemberStatus>;

/** A human and their agent, enrolled through an invite rather than mesh.yaml. */
export const MemberRecord = z.object({
  humanId: ParticipantId,
  agentId: ParticipantId,
  displayName: z.string().min(1),
  discordUserId: DiscordUserId.nullable(),
  roles: z.array(z.string()),
  skills: z.array(z.string()),
  /** The agent's public nkey, generated on the member's laptop. */
  nkey: PublicNkey,
  status: MemberStatus,
  invitedBy: z.string(),
  joinedAt: IsoDate,
  removedAt: IsoDate.nullable(),
});
export type MemberRecord = z.infer<typeof MemberRecord>;
