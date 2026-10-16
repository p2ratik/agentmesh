import type { Db } from '../../db/database';

/** Maps mesh entities to ids in external systems (e.g. a Discord thread id). */
export class RefsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Upserts the ref. An external id points at exactly one entity, so a previous
   * entity holding the same ref in that system loses it (newest mapping wins).
   */
  set(system: string, entityType: string, entityId: string, ref: string): void {
    this.#db.transaction(() => {
      this.#db.run(
        `DELETE FROM external_refs WHERE system = $system AND ref = $ref
         AND NOT (entity_type = $entityType AND entity_id = $entityId)`,
        { system, ref, entityType, entityId },
      );
      this.#db.run(
        `INSERT INTO external_refs (system, entity_type, entity_id, ref)
         VALUES ($system, $entityType, $entityId, $ref)
         ON CONFLICT (system, entity_type, entity_id) DO UPDATE SET ref = excluded.ref`,
        { system, entityType, entityId, ref },
      );
    });
  }

  get(system: string, entityType: string, entityId: string): string | null {
    const row = this.#db.get<{ ref: string }>(
      `SELECT ref FROM external_refs
       WHERE system = $system AND entity_type = $entityType AND entity_id = $entityId`,
      { system, entityType, entityId },
    );
    return row?.ref ?? null;
  }

  find(system: string, ref: string): { entityType: string; entityId: string } | null {
    const row = this.#db.get<{ entity_type: string; entity_id: string }>(
      'SELECT entity_type, entity_id FROM external_refs WHERE system = $system AND ref = $ref',
      { system, ref },
    );
    return row ? { entityType: row.entity_type, entityId: row.entity_id } : null;
  }
}
