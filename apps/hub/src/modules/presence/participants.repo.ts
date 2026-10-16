import type { ParticipantKind } from '@agentmesh/protocol';
import type { Db } from '../../db/database';

export type DeclaredStatus = 'online' | 'busy' | 'away';

export interface ParticipantRow {
  id: string;
  kind: ParticipantKind;
  display_name: string;
  owner: string | null;
  declared_status: DeclaredStatus;
  status_note: string | null;
  online: number;
  repo: string | null;
  branch: string | null;
  last_seen: string | null;
  last_assigned_at: string | null;
  configured: number;
}

/** The fields presence changes at runtime. */
export type PresenceFields = Pick<
  ParticipantRow,
  'declared_status' | 'status_note' | 'online' | 'repo' | 'branch' | 'last_seen'
>;

export interface ConfiguredParticipant {
  id: string;
  kind: ParticipantKind;
  displayName: string;
  owner: string | null;
}

const KIND_ORDER = "CASE kind WHEN 'agent' THEN 0 WHEN 'human' THEN 1 ELSE 2 END";

/** Data access for the `participants` table (identity from config + live presence). */
export class ParticipantsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Upserts every configured participant and flags rows that left the config. */
  sync(participants: ConfiguredParticipant[]): void {
    this.#db.transaction(() => {
      this.#db.run('UPDATE participants SET configured = 0');
      for (const p of participants) {
        this.#db.run(
          `INSERT INTO participants (id, kind, display_name, owner, configured)
           VALUES ($id, $kind, $displayName, $owner, 1)
           ON CONFLICT (id) DO UPDATE SET kind = excluded.kind,
             display_name = excluded.display_name, owner = excluded.owner, configured = 1`,
          { id: p.id, kind: p.kind, displayName: p.displayName, owner: p.owner },
        );
      }
    });
  }

  get(id: string): ParticipantRow | undefined {
    return this.#db.get<ParticipantRow>('SELECT * FROM participants WHERE id = $id', { id });
  }

  /** Configured participants, agents first, then humans, then services. */
  list(kind: ParticipantKind | null): ParticipantRow[] {
    return this.#db.all<ParticipantRow>(
      `SELECT * FROM participants WHERE configured = 1 AND ($kind IS NULL OR kind = $kind)
       ORDER BY ${KIND_ORDER}, id`,
      { kind },
    );
  }

  update(id: string, fields: PresenceFields): void {
    this.#db.run(
      `UPDATE participants SET declared_status = $declared, status_note = $note, online = $online,
         repo = $repo, branch = $branch, last_seen = $lastSeen
       WHERE id = $id`,
      {
        id,
        declared: fields.declared_status,
        note: fields.status_note,
        online: fields.online,
        repo: fields.repo,
        branch: fields.branch,
        lastSeen: fields.last_seen,
      },
    );
  }

  /** Online participants whose last heartbeat is older than `cutoff`. */
  stale(cutoff: string): string[] {
    return this.#db
      .all<{ id: string }>(
        'SELECT id FROM participants WHERE online = 1 AND (last_seen IS NULL OR last_seen < $cutoff)',
        { cutoff },
      )
      .map((r) => r.id);
  }

  setLastAssigned(id: string, at: string): void {
    this.#db.run('UPDATE participants SET last_assigned_at = $at WHERE id = $id', { id, at });
  }
}
