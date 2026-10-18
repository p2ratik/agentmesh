import { z } from 'zod';
import { DiscordUserId, InviteId, MemberRecord } from '../enrollment';
import { IsoDate, ParticipantId } from '../primitives';
import { defineMethod } from './define';

export const enrollmentMethods = {
  'enrollment.invite': defineMethod({
    description:
      'Create a one-time invite for a new member. The code in the result is a secret: DM it to the invitee, never post or log it.',
    callers: ['human'],
    requiresRole: 'admin',
    // The result holds the invite secret: never store it in the idempotency cache.
    cacheResponse: false,
    params: z.object({
      humanId: ParticipantId,
      displayName: z.string().min(1).max(80),
      /** The invitee's Discord account, recorded on the member. Redemption does not prove it: the code is a bearer token. */
      discordUserId: DiscordUserId,
      roles: z.array(z.string().min(1).max(40)).max(10).default([]),
      skills: z.array(z.string().min(1).max(40)).max(20).default([]),
      /** Defaults to `{humanId}-agent`. */
      agentId: ParticipantId.optional(),
    }),
    result: z.object({
      inviteId: InviteId,
      code: z.string(),
      humanId: ParticipantId,
      agentId: ParticipantId,
      expiresAt: IsoDate,
    }),
  }),
  'enrollment.cancelInvite': defineMethod({
    description: 'Revoke an unused invite (e.g. when the DM could not be delivered).',
    callers: ['human'],
    requiresRole: 'admin',
    params: z.object({ inviteId: InviteId }),
    result: z.object({ cancelled: z.boolean() }),
  }),
  'enrollment.remove': defineMethod({
    description: 'Remove an enrolled member: their agent is disconnected and refused from now on.',
    callers: ['human'],
    requiresRole: 'admin',
    params: z.object({ humanId: ParticipantId }),
    result: z.object({ removed: z.boolean(), agentIds: z.array(ParticipantId) }),
  }),
  'enrollment.list': defineMethod({
    description: 'Bridges only: every enrolled member (active and revoked), to build their index.',
    callers: ['service'],
    requiresRole: 'bridge',
    params: z.object({}),
    result: z.object({ members: z.array(MemberRecord) }),
  }),
} as const;
