import type { Db } from '../../db/database';

export type SessionLiveness = 'live' | 'away' | 'closed';

export interface SessionRow {
  id: string;
  agent_id: string;
  active: number;
  liveness: SessionLiveness;
  description: string | null;
  repo: string | null;
  branch: string | null;
  client_version: string;
  created_at: string;
  activated_at: string | null;
  last_seen: string;
  away_since: string | null;
  closed_at: string | null;
  /** JSON array of thread ids released at close. */
  released: string;
}

export interface NewSession {
  id: string;
  agentId: string;
  clientVersion: string;
  description?: string | null;
  repo?: string | null;
  branch?: string | null;
  at: string;
}

const NOT_CLOSED = "liveness <> 'closed'";

/** Data access for `sessions` and `thread_owners`. No business rules. */
export class SessionsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** A new session starts live and inactive. */
  insert(row: NewSession): void {
    this.#db.run(
      `INSERT INTO sessions (id, agent_id, active, liveness, description, repo, branch,
         client_version, created_at, last_seen)
       VALUES ($id, $agentId, 0, 'live', $description, $repo, $branch, $clientVersion, $at, $at)`,
      {
        id: row.id,
        agentId: row.agentId,
        description: row.description ?? null,
        repo: row.repo ?? null,
        branch: row.branch ?? null,
        clientVersion: row.clientVersion,
        at: row.at,
      },
    );
  }

  get(id: string): SessionRow | undefined {
    return this.#db.get<SessionRow>('SELECT * FROM sessions WHERE id = $id', { id });
  }

  /** The agent's non-closed sessions, oldest first. */
  listLive(agentId: string): SessionRow[] {
    return this.#db.all<SessionRow>(
      `SELECT * FROM sessions WHERE agent_id = $agentId AND ${NOT_CLOSED} ORDER BY created_at, id`,
      { agentId },
    );
  }

  /** Heartbeat: bumps last_seen; repo/branch are replaced only when given. */
  touch(id: string, at: string, git: { repo?: string | null; branch?: string | null } = {}): void {
    this.#db.run(
      `UPDATE sessions SET last_seen = $at, repo = COALESCE($repo, repo), branch = COALESCE($branch, branch)
       WHERE id = $id`,
      { id, at, repo: git.repo ?? null, branch: git.branch ?? null },
    );
  }

  /** Activating stamps `activated_at`; deactivating keeps it. */
  setActive(id: string, active: boolean, at: string): void {
    this.#db.run(
      `UPDATE sessions SET active = $active,
         activated_at = CASE WHEN $active = 1 THEN $at ELSE activated_at END
       WHERE id = $id`,
      { id, active: active ? 1 : 0, at },
    );
  }

  setDescription(id: string, text: string | null): void {
    this.#db.run('UPDATE sessions SET description = $text WHERE id = $id', { id, text });
  }

  markAway(id: string, at: string): void {
    this.#db.run(
      "UPDATE sessions SET liveness = 'away', away_since = $at WHERE id = $id AND liveness = 'live'",
      { id, at },
    );
  }

  markLive(id: string): void {
    this.#db.run(
      "UPDATE sessions SET liveness = 'live', away_since = NULL WHERE id = $id AND liveness = 'away'",
      { id },
    );
  }

  /** Closes the session, deactivates it and records the thread ids it released. */
  close(id: string, at: string, released: number[]): void {
    this.#db.run(
      `UPDATE sessions SET liveness = 'closed', active = 0, closed_at = $at, released = $released
       WHERE id = $id`,
      { id, at, released: JSON.stringify(released) },
    );
  }

  owner(threadId: number, agentId: string): string | null {
    return (
      this.#db.get<{ session_id: string }>(
        'SELECT session_id FROM thread_owners WHERE thread_id = $threadId AND agent_id = $agentId',
        { threadId, agentId },
      )?.session_id ?? null
    );
  }

  /** Creates or replaces the owner of a thread for an agent. */
  setOwner(threadId: number, agentId: string, sessionId: string, at: string): void {
    this.#db.run(
      `INSERT INTO thread_owners (thread_id, agent_id, session_id, since)
       VALUES ($threadId, $agentId, $sessionId, $at)
       ON CONFLICT (thread_id, agent_id) DO UPDATE SET session_id = $sessionId, since = $at`,
      { threadId, agentId, sessionId, at },
    );
  }

  /** Deletes the session's ownerships and returns the thread ids it held. */
  releaseOwned(sessionId: string): number[] {
    const ids = this.ownedThreads(sessionId);
    this.#db.run('DELETE FROM thread_owners WHERE session_id = $sessionId', { sessionId });
    return ids;
  }

  ownedThreads(sessionId: string): number[] {
    return this.#db
      .all<{ thread_id: number }>(
        'SELECT thread_id FROM thread_owners WHERE session_id = $sessionId ORDER BY thread_id',
        { sessionId },
      )
      .map((r) => r.thread_id);
  }

  /** Live sessions not seen since `before` (ISO). */
  staleLive(before: string): SessionRow[] {
    return this.#db.all<SessionRow>(
      "SELECT * FROM sessions WHERE liveness = 'live' AND last_seen < $before ORDER BY last_seen",
      { before },
    );
  }

  /** Away sessions that went away before `before` (ISO). */
  awayBefore(before: string): SessionRow[] {
    return this.#db.all<SessionRow>(
      "SELECT * FROM sessions WHERE liveness = 'away' AND away_since < $before ORDER BY away_since",
      { before },
    );
  }
}
