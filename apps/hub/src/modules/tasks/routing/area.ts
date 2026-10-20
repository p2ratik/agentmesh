import { MeshError } from '@agentmesh/common';
import type { AssignmentConfig, ConfigIndex } from '@agentmesh/config';

/** The task facts routing looks at. */
export interface RoutingSubject {
  area: string | null;
  labels: readonly string[];
  declinedBy: readonly string[];
}

/** The area of a new task: the given one (must exist), else the first area that lists the repo. */
export function resolveArea(index: ConfigIndex, area?: string, repo?: string): string | null {
  if (area) {
    if (!index.area(area)) throw new MeshError('invalid_request', `Unknown area "${area}"`);
    return area;
  }
  return repo ? (index.areasForRepo(repo)[0]?.id ?? null) : null;
}

/** Skills that make an agent relevant to a task: its labels plus its area's skills. */
export function taskSkills(index: ConfigIndex, task: RoutingSubject): Set<string> {
  const areaSkills = task.area ? (index.area(task.area)?.skills ?? []) : [];
  return new Set([...task.labels, ...areaSkills]);
}

/**
 * Who may own the task, in preference order, before load and capacity: the
 * area's owners; without an area, agents with a skill among the task's labels.
 */
export function ownerPool(index: ConfigIndex, task: RoutingSubject): string[] {
  if (task.area) {
    return index.area(task.area)?.owners ?? [];
  }
  const labels = new Set(task.labels);
  return index
    .agents()
    .filter((a) => a.skills.some((s) => labels.has(s)))
    .map((a) => a.id);
}

/** Agents told about an unowned task on the board (never those who declined it). */
export function boardAudience(
  index: ConfigIndex,
  task: RoutingSubject,
  mode: AssignmentConfig['boardAnnounce'],
  isOnline: (id: string) => boolean,
): string[] {
  const skills = taskSkills(index, task);
  const agents = index.agents().filter((a) => !task.declinedBy.includes(a.id));
  if (mode === 'online') return agents.filter((a) => isOnline(a.id)).map((a) => a.id);
  if (mode === 'matching-skills') {
    return agents.filter((a) => a.skills.some((s) => skills.has(s))).map((a) => a.id);
  }
  return [];
}
