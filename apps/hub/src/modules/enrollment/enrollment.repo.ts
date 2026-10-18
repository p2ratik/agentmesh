import type { MemberRecord } from '@agentmesh/protocol';
import type { Db } from '../../db/database';

export interface InviteRow {
  id: string;
  secret_sha256: string;
  human_id: string;
  agent_id: string;
  display_name: string;
  discord_user_id: string;
  roles: string;
  skills: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  cancelled_at: string | null;
}

interface MemberRow {
  human_id: string;
  agent_id: string;
  display_name: string;
  discord_user_id: string | null;
  roles: string;
  skills: string;
  nkey: string;
  status: 'active' | 'revoked';
  invited_by: string;
  joined_at: string;
  removed_at: string | null;
}

export interface NewInvite {
  id: string;
  secretSha256: string;
  humanId: string;
  agentId: string;
  displayName: string;
  discordUserId: string;
  roles: string[];
  skills: string[];
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

/** `enrollment_invites` and `enrollment_members`. Only the enrollment service uses it. */
export class EnrollmentRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insertInvite(invite: NewInvite): void {
    this.#db.run(
      `INSERT INTO enrollment_invites (id, secret_sha256, human_id, agent_id, display_name,
         discord_user_id, roles, skills, invited_by, created_at, expires_at)
       VALUES ($id, $secretSha256, $humanId, $agentId, $displayName, $discordUserId, $roles,
         $skills, $invitedBy, $createdAt, $expiresAt)`,
      { ...invite, roles: JSON.stringify(invite.roles), skills: JSON.stringify(invite.skills) },
    );
  }

  invite(id: string): InviteRow | undefined {
    return this.#db.get<InviteRow>('SELECT * FROM enrollment_invites WHERE id = $id', { id });
  }

  /** Unused, uncancelled, unexpired invites that claim this id or Discord id. */
  openInviteClaiming(now: string, ids: string[], discordUserId: string): InviteRow | undefined {
    return this.#db.get<InviteRow>(
      `SELECT * FROM enrollment_invites
       WHERE used_at IS NULL AND cancelled_at IS NULL AND expires_at > $now
         AND (human_id IN (SELECT value FROM json_each($ids))
           OR agent_id IN (SELECT value FROM json_each($ids))
           OR discord_user_id = $discordUserId)
       LIMIT 1`,
      { now, ids: JSON.stringify(ids), discordUserId },
    );
  }

  /** Marks an open invite used. False when it was used, cancelled or expired meanwhile. */
  markUsed(id: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE enrollment_invites SET used_at = $now
         WHERE id = $id AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > $now`,
        { id, now },
      ).changes === 1
    );
  }

  cancel(id: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE enrollment_invites SET cancelled_at = $now
         WHERE id = $id AND used_at IS NULL AND cancelled_at IS NULL`,
        { id, now },
      ).changes === 1
    );
  }

  /**
   * Inserts the member, or re-enrolls a removed one under the same human id.
   * False when that human is already an active member. A key or agent id held
   * by another member violates a UNIQUE constraint and throws.
   */
  upsertMember(invite: InviteRow, nkey: string, joinedAt: string): boolean {
    const { changes } = this.#db.run(
      `INSERT INTO enrollment_members (human_id, agent_id, display_name, discord_user_id, roles,
         skills, nkey, status, invited_by, invite_id, joined_at, removed_at)
       VALUES ($humanId, $agentId, $displayName, $discordUserId, $roles, $skills, $nkey, 'active',
         $invitedBy, $inviteId, $joinedAt, NULL)
       ON CONFLICT (human_id) DO UPDATE SET
         agent_id = excluded.agent_id, display_name = excluded.display_name,
         discord_user_id = excluded.discord_user_id, roles = excluded.roles,
         skills = excluded.skills, nkey = excluded.nkey, status = 'active',
         invited_by = excluded.invited_by, invite_id = excluded.invite_id,
         joined_at = excluded.joined_at, removed_at = NULL
       WHERE enrollment_members.status = 'revoked'`,
      {
        humanId: invite.human_id,
        agentId: invite.agent_id,
        displayName: invite.display_name,
        discordUserId: invite.discord_user_id,
        roles: invite.roles,
        skills: invite.skills,
        nkey,
        invitedBy: invite.invited_by,
        inviteId: invite.id,
        joinedAt,
      },
    );
    return changes === 1;
  }

  revoke(humanId: string, now: string): boolean {
    return (
      this.#db.run(
        `UPDATE enrollment_members SET status = 'revoked', removed_at = $now
         WHERE human_id = $humanId AND status = 'active'`,
        { humanId, now },
      ).changes === 1
    );
  }

  member(humanId: string): MemberRecord | undefined {
    const row = this.#db.get<MemberRow>(
      'SELECT * FROM enrollment_members WHERE human_id = $humanId',
      { humanId },
    );
    return row ? toMember(row) : undefined;
  }

  /** Any member, active or revoked, that holds this key. */
  memberByNkey(nkey: string): MemberRecord | undefined {
    const row = this.#db.get<MemberRow>('SELECT * FROM enrollment_members WHERE nkey = $nkey', {
      nkey,
    });
    return row ? toMember(row) : undefined;
  }

  members(): MemberRecord[] {
    return this.#db
      .all<MemberRow>('SELECT * FROM enrollment_members ORDER BY joined_at, human_id')
      .map(toMember);
  }
}

function toMember(row: MemberRow): MemberRecord {
  return {
    humanId: row.human_id,
    agentId: row.agent_id,
    displayName: row.display_name,
    discordUserId: row.discord_user_id,
    roles: JSON.parse(row.roles) as string[],
    skills: JSON.parse(row.skills) as string[],
    nkey: row.nkey,
    status: row.status,
    invitedBy: row.invited_by,
    joinedAt: row.joined_at,
    removedAt: row.removed_at,
  };
}
