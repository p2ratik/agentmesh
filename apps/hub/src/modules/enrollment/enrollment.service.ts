import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HOUR_MS, isValidParticipantId, MeshError, MINUTE_MS } from '@agentmesh/common';
import { ConfigIndex, claimedByConfig, pendingInvitees, withMembers } from '@agentmesh/config';
import {
  type CancelStatus,
  encodeInvite,
  type MemberRecord,
  type OpenInvite,
  PublicNkey,
  type RpcParams,
  type RpcResult,
} from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { Actor, EnrollmentService, RedeemInput } from '../../contracts';
import { EnrollmentRepo, type InviteRow } from './enrollment.repo';

export interface EnrollmentDeps {
  /** Disconnects the agent's live connections (the auth callout); null without it. */
  kick?: ((agentId: string) => Promise<void>) | null;
  /** Runs after every committed join or removal, once `ctx.index` is current. */
  onMembersChanged(): void;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

/** One answer for every refusal, so a caller learns nothing about why. */
const refused = () => new MeshError('unauthenticated', 'Invite or key not accepted');

function inviteState(invite: InviteRow, now: string): CancelStatus | 'open' {
  if (invite.used_at) return 'used';
  if (invite.cancelled_at) return 'already_cancelled';
  if (invite.expires_at <= now) return 'expired';
  return 'open';
}

/**
 * The team registry: invites, members, and the merged config index. The hub
 * is its only writer; every change commits with its outbox event.
 */
export class EnrollmentServiceImpl implements EnrollmentService {
  readonly #ctx: HubContext;
  readonly #repo: EnrollmentRepo;
  readonly #deps: EnrollmentDeps;

  constructor(ctx: HubContext, deps: EnrollmentDeps) {
    this.#ctx = ctx;
    this.#repo = new EnrollmentRepo(ctx.db);
    this.#deps = deps;
    this.refreshIndex();
  }

  /** Rebuilds `ctx.index` from mesh.yaml plus the active members. */
  refreshIndex(): void {
    const { config, shadowed } = withMembers(this.#ctx.loaded.config, this.#repo.members());
    if (shadowed.length > 0) {
      this.#ctx.logger.warn({ members: shadowed }, 'enrolled members shadowed by mesh.yaml');
    }
    const pending = pendingInvitees(config);
    if (pending.length > 0) {
      this.#ctx.logger.warn(
        { people: pending },
        'people in mesh.yaml not on the team yet (join by invite)',
      );
    }
    this.#ctx.setIndex(new ConfigIndex(config));
  }

  invite(params: RpcParams<'enrollment.invite'>, actor: Actor): RpcResult<'enrollment.invite'> {
    const { enrollment } = this.#ctx.loaded.config;
    if (!enrollment.natsUrl) {
      throw new MeshError('unavailable', 'Set enrollment.natsUrl in mesh.yaml to invite members');
    }
    const { humanId, discordUserId } = params;
    const agentId = params.agentId ?? `${humanId}-agent`;
    const now = this.#ctx.clock.now();
    this.#assertFree(humanId, agentId, discordUserId, now.toISOString());

    const inviteId = `inv-${randomBytes(9).toString('hex')}`;
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + enrollment.inviteTtlHours * HOUR_MS).toISOString();
    this.#repo.insertInvite({
      id: inviteId,
      secretSha256: sha256(secret).toString('hex'),
      humanId,
      agentId,
      displayName: params.displayName,
      discordUserId,
      roles: params.roles,
      skills: params.skills,
      invitedBy: actor.id,
      createdAt: now.toISOString(),
      expiresAt,
    });
    this.#ctx.logger.info({ inviteId, humanId, agentId, by: actor.id }, 'invite created');
    const code = encodeInvite({
      v: 1,
      natsUrl: enrollment.natsUrl,
      inviteId,
      agentId,
      prefix: this.#ctx.loaded.config.mesh.prefix,
      secret,
    });
    return { inviteId, code, humanId, agentId, expiresAt };
  }

  /**
   * Cancels an unused invite, by id or as the person's latest. Idempotent:
   * anything but an open invite is left alone and reported as found.
   */
  cancelInvite(
    params: RpcParams<'enrollment.cancelInvite'>,
    actor: Actor,
  ): RpcResult<'enrollment.cancelInvite'> {
    const invite =
      'inviteId' in params
        ? this.#repo.invite(params.inviteId)
        : this.#repo.latestInviteFor(params.humanId);
    if (!invite) return { cancelled: false, status: 'not_found' };
    const now = this.#ctx.clock.now().toISOString();
    const state = inviteState(invite, now);
    if (state !== 'open') return { cancelled: false, status: state, inviteId: invite.id };
    if (!this.#repo.cancel(invite.id, now)) {
      // Redeemed or cancelled between the read and the update.
      const status = this.#repo.invite(invite.id)?.used_at ? 'used' : 'already_cancelled';
      return { cancelled: false, status, inviteId: invite.id };
    }
    this.#ctx.logger.info(
      { inviteId: invite.id, humanId: invite.human_id, by: actor.id },
      'invite cancelled',
    );
    return { cancelled: true, status: 'cancelled', inviteId: invite.id };
  }

  /** Open invites for the bridge's autocomplete; never the secret or its hash. */
  openInvites(): OpenInvite[] {
    return this.#repo.openInvites(this.#ctx.clock.now().toISOString()).map((row) => ({
      inviteId: row.id,
      humanId: row.human_id,
      agentId: row.agent_id,
      displayName: row.display_name,
      discordUserId: row.discord_user_id,
      invitedBy: row.invited_by,
      expiresAt: row.expires_at,
    }));
  }

  async redeem(input: RedeemInput): Promise<MemberRecord> {
    const now = this.#ctx.clock.now().toISOString();
    const invite = this.#checkRedeem(input, now);
    let member: MemberRecord;
    try {
      member = this.#ctx.db.transaction(() => {
        if (!this.#repo.markUsed(invite.id, now)) throw this.#refuse(invite.id, 'invite used');
        if (!this.#repo.upsertMember(invite, input.nkey, now)) {
          throw this.#refuse(invite.id, 'already an active member');
        }
        const joined = this.#repo.member(invite.human_id) as MemberRecord;
        this.#ctx.outbox.enqueueEvent('member.joined', { member: joined });
        return joined;
      });
    } catch (error) {
      if (error instanceof MeshError) throw error;
      this.#ctx.logger.error({ err: error, inviteId: invite.id }, 'invite redemption failed');
      throw refused();
    }
    this.#ctx.outbox.kick();
    this.#changed();
    this.#ctx.logger.info({ humanId: member.humanId, agentId: member.agentId }, 'member joined');
    return member;
  }

  async remove(humanId: string, actor: Actor): Promise<RpcResult<'enrollment.remove'>> {
    const existing = this.#repo.member(humanId);
    if (existing?.status !== 'active') {
      if (this.#ctx.index.human(humanId)) {
        throw new MeshError(
          'invalid_request',
          `${humanId} is defined in mesh.yaml; remove them there`,
        );
      }
      return { removed: false, agentIds: [] };
    }
    const now = this.#ctx.clock.now().toISOString();
    const member = this.#ctx.db.transaction(() => {
      this.#repo.revoke(humanId, now);
      const removed = this.#repo.member(humanId) as MemberRecord;
      this.#ctx.outbox.enqueueEvent('member.removed', { member: removed, by: actor.id });
      return removed;
    });
    this.#ctx.outbox.kick();
    this.#changed();
    this.#ctx.logger.info({ humanId, agentId: member.agentId, by: actor.id }, 'member removed');
    // Revoked and out of the index first, so the kicked client's reconnect is refused.
    await this.#deps.kick?.(member.agentId).catch((err: unknown) => {
      this.#ctx.logger.error({ err, agentId: member.agentId }, 'could not kick removed agent');
    });
    return { removed: true, agentIds: [member.agentId] };
  }

  list(): MemberRecord[] {
    return this.#repo.members();
  }

  #changed(): void {
    this.refreshIndex();
    this.#deps.onMembersChanged();
  }

  /** Refuses ids, Discord ids or open invites the team already uses. */
  #assertFree(humanId: string, agentId: string, discordUserId: string, now: string): void {
    const index = this.#ctx.index;
    if (!isValidParticipantId(agentId) || agentId === humanId) {
      throw new MeshError('invalid_request', `"${agentId}" is not a usable agent id`);
    }
    for (const id of [humanId, agentId]) {
      if (index.kindOf(id) || id === index.config.hub.serviceId) {
        throw new MeshError('conflict', `"${id}" is already on the team`);
      }
    }
    const previous = this.#repo.members().find((m) => m.agentId === agentId);
    if (previous && previous.humanId !== humanId) {
      throw new MeshError('conflict', `"${agentId}" belonged to a removed member; pick another id`);
    }
    // NATS and the RPC router authorize by agent id, not by key: a connection that outlived the
    // removal (missed kick, hub restart) would act as the new member until its credentials expire.
    const { userJwtTtlMinutes } = this.#ctx.loaded.config.enrollment;
    const removedAt = previous?.removedAt ? Date.parse(previous.removedAt) : Number.NaN;
    const waitMs = removedAt + userJwtTtlMinutes * MINUTE_MS - Date.parse(now);
    if (waitMs > 0) {
      throw new MeshError(
        'conflict',
        `"${agentId}" was removed less than ${userJwtTtlMinutes} minutes ago and its old ` +
          `connections may still be valid. Wait ${Math.ceil(waitMs / MINUTE_MS)} minutes, ` +
          'or invite with another agent id.',
      );
    }
    if (index.humanByDiscordId(discordUserId)) {
      throw new MeshError('conflict', 'That Discord account already belongs to a team member');
    }
    const open = this.#repo.openInviteClaiming(now, [humanId, agentId], discordUserId);
    if (open) {
      throw new MeshError(
        'conflict',
        `Invite ${open.id} is still open for this person; cancel it first`,
      );
    }
  }

  /** Everything a redemption needs that can be checked before touching NATS. */
  #checkRedeem(input: RedeemInput, now: string): InviteRow {
    const invite = this.#repo.invite(input.inviteId);
    if (!invite) throw this.#refuse(input.inviteId, 'unknown invite');
    const expected = Buffer.from(invite.secret_sha256, 'hex');
    if (!timingSafeEqual(sha256(input.secret), expected)) {
      throw this.#refuse(invite.id, 'wrong secret');
    }
    if (invite.used_at || invite.cancelled_at || invite.expires_at <= now) {
      throw this.#refuse(invite.id, 'invite used, cancelled or expired');
    }
    if (!PublicNkey.safeParse(input.nkey).success) throw this.#refuse(invite.id, 'malformed key');
    const index = this.#ctx.index;
    if (
      claimedByConfig(index.config).nkeys.has(input.nkey) ||
      this.#repo.memberByNkey(input.nkey)
    ) {
      throw this.#refuse(invite.id, 'key already in use');
    }
    if (
      index.kindOf(invite.human_id) ||
      index.kindOf(invite.agent_id) ||
      index.humanByDiscordId(invite.discord_user_id)
    ) {
      throw this.#refuse(invite.id, 'id or Discord account taken since the invite was made');
    }
    return invite;
  }

  #refuse(inviteId: string, reason: string): MeshError {
    this.#ctx.logger.warn({ inviteId, reason }, 'invite redemption refused');
    return refused();
  }
}
