import { boardAudience, ownerPool } from '../routing/area';
import { pickAssignee } from '../routing/assignment';
import { boardText } from '../text';
import type { Effect } from './types';

/**
 * Routes an unowned task: the least-loaded eligible owner gets it (via the
 * workflow's `assign` transition); with nobody eligible it stays on the board
 * and matching agents are told they can claim it. Tasks waiting on unfinished
 * dependencies stay put until `release_dependents` routes them.
 */
export const autoAssign: Effect = (env, run) => {
  const { task } = run;
  if (task.assignee || !env.views.dependenciesDone(task.id)) return;
  const { index, clock } = env.ctx;
  const { presence, messaging } = env.deps;
  const cfg = index.config.assignment;
  const winner = pickAssignee({
    pool: ownerPool(index, task),
    declinedBy: task.declinedBy,
    load: env.views.activeLoad(),
    maxActive: cfg.maxActiveTasksPerAgent,
    preferOnline: cfg.preferOnline,
    isOnline: (id) => presence.isOnline(id),
    lastAssignedAt: (id) => presence.lastAssignedAt(id),
  });
  if (winner && env.applySystem(task.id, 'assign', { to: winner })) {
    presence.markAssigned(winner, clock.now());
    return;
  }
  const audience = boardAudience(index, task, cfg.boardAnnounce, (id) => presence.isOnline(id));
  if (audience.length === 0) return;
  env.post({
    threadId: task.threadId,
    senderId: messaging.hubId,
    kind: 'task',
    body: boardText(task),
    to: audience,
    addToThread: false,
    trust: task.trust,
    refs: { action: 'board' },
  });
};
