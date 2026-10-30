import type { SessionSummary, SessionView } from '@agentmesh/protocol';
import type { SessionRecord } from '../../contracts';
import type { RouteSession } from './routing';
import type { SessionRow } from './sessions.repo';

/** Pure row mappers for the sessions service. */

export function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    active: row.active === 1,
    liveness: row.liveness,
    delivery: row.delivery,
    description: row.description,
    repo: row.repo,
    branch: row.branch,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    lastSeen: row.last_seen,
  };
}

/** `owns`: thread keys (`thr-3`). */
export function toView(row: SessionRow, owns: string[]): SessionView {
  return {
    id: row.id,
    active: row.active === 1,
    delivery: row.delivery,
    description: row.description,
    repo: row.repo,
    branch: row.branch,
    owns,
  };
}

/** `tasks`: keys of the tasks whose threads the session owns. */
export function toSummary(row: SessionRow, tasks: string[]): SessionSummary {
  return {
    id: row.id,
    delivery: row.delivery,
    description: row.description ?? '',
    repo: row.repo,
    branch: row.branch,
    activeSince: row.activated_at ?? row.created_at,
    tasks,
  };
}

/** A non-closed session as routing sees it. */
export function toRouteSession(row: SessionRow): RouteSession {
  return {
    id: row.id,
    active: row.active === 1,
    liveness: row.liveness === 'live' ? 'live' : 'away',
    delivery: row.delivery,
    repo: row.repo,
    activatedAt: row.activated_at,
  };
}
