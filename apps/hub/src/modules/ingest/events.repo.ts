import type { StoredIngestEvent } from '@agentmesh/protocol';
import { type Db, toJson } from '../../db/database';

/** `ingest_events` (dedup + audit) and `rule_throttles`. */
export class IngestRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Returns false when the id was already stored (a duplicate). */
  insert(event: StoredIngestEvent): boolean {
    return (
      this.#db.run(
        `INSERT OR IGNORE INTO ingest_events
           (id, source, type, severity, summary, url, payload, occurred_at, received_at)
         VALUES ($id, $source, $type, $severity, $summary, $url, $payload, $occurredAt, $receivedAt)`,
        {
          id: event.id,
          source: event.source,
          type: event.type,
          severity: event.severity,
          summary: event.summary ?? null,
          url: event.url ?? null,
          payload: toJson(event.payload),
          occurredAt: event.occurredAt ?? null,
          receivedAt: event.receivedAt,
        },
      ).changes === 1
    );
  }

  setMatchedRules(id: string, rules: readonly string[]): void {
    this.#db.run('UPDATE ingest_events SET matched_rules = $rules WHERE id = $id', {
      id,
      rules: toJson(rules),
    });
  }

  /**
   * Claims a throttle slot: true (and records `until`) when the rule may fire
   * for this key now, false while an earlier firing's window is still open.
   */
  claimThrottle(ruleId: string, key: string, now: string, until: string): boolean {
    const current = this.#db.get<{ until: string }>(
      'SELECT until FROM rule_throttles WHERE rule_id = $ruleId AND key = $key',
      { ruleId, key },
    );
    if (current && current.until > now) return false;
    this.#db.run(
      'INSERT OR REPLACE INTO rule_throttles (rule_id, key, until) VALUES ($ruleId, $key, $until)',
      { ruleId, key, until },
    );
    return true;
  }
}
