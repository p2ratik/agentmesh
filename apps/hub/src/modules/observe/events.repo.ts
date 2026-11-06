import type { HubEvent, ObservedEvent, ReportedEvent } from '@agentmesh/protocol';
import type { Db } from '../../db/database';

export interface EventFilter {
  agent?: string;
  session?: string;
  thread?: string;
  /** ISO times, compared with the hub's receive time. */
  since?: string;
  until?: string;
  kinds?: readonly string[];
  limit?: number;
}

interface Row {
  agent: string;
  received_at: string;
  body: string;
}

export class EventsRepo {
  constructor(private readonly db: Db) {}

  /** True if the row is new; a repeated id is ignored. */
  insert(agent: string, event: ReportedEvent | HubEvent, receivedAt: string): boolean {
    const thread = 'thread' in event && event.thread ? event.thread : null;
    return (
      this.db.run(
        `INSERT OR IGNORE INTO events (id, agent, session, thread, kind, source, at, received_at, body)
         VALUES ($id, $agent, $session, $thread, $kind, $source, $at, $receivedAt, $body)`,
        {
          id: event.id,
          agent,
          session: event.session,
          thread,
          kind: event.kind,
          source: event.source,
          at: event.at,
          receivedAt,
          body: JSON.stringify(event),
        },
      ).changes > 0
    );
  }

  prune(before: string): number {
    return this.db.run('DELETE FROM events WHERE received_at < $before', { before }).changes;
  }

  /** Oldest first. */
  query(filter: EventFilter): ObservedEvent[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    const add = (clause: string, key: string, value: string | undefined) => {
      if (value === undefined) return;
      where.push(clause);
      params[key] = value;
    };
    add('agent = $agent', 'agent', filter.agent);
    add('session = $session', 'session', filter.session);
    add('thread = $thread', 'thread', filter.thread);
    add('received_at >= $since', 'since', filter.since);
    add('received_at <= $until', 'until', filter.until);
    if (filter.kinds?.length) {
      const names = filter.kinds.map((kind, i) => {
        params[`kind${i}`] = kind;
        return `$kind${i}`;
      });
      where.push(`kind IN (${names.join(', ')})`);
    }
    params.limit = filter.limit ?? 500;
    const sql = `SELECT agent, received_at, body FROM events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY received_at, rowid LIMIT $limit`;
    return this.db
      .all<Row>(sql, params)
      .map((r) => ({ ...JSON.parse(r.body), agent: r.agent, receivedAt: r.received_at }));
  }
}
