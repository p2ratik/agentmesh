import { taskKey } from '../../../core/ids';
import type { TaskRecord } from '../repo';
import { taskSkills } from '../routing/area';
import { selectReviewers } from '../routing/reviewers';
import { noReviewerText, reviewRequestText } from '../text';
import type { Effect, EffectEnv } from './types';

/**
 * Starts a review round. Reviewers, in order of precedence: those pinned when
 * the task was created (`review.request`), the previous round's reviewers
 * (re-reviews go back to the same people), or a fresh selection. Configured
 * human reviewers are always added. The assignee never reviews their own work.
 */
export const requestReviews: Effect = (env, run) => {
  const { ctx, repos, deps } = env;
  let task = run.task;
  const round = Math.max(1, task.reviewRound);
  if (round !== task.reviewRound) {
    repos.tasks.update(task.id, { reviewRound: round }, ctx.clock.now().toISOString());
    task = repos.tasks.require(task.id);
  }
  const agents = chooseAgents(env, task, round).filter((id) => id !== task.assignee);
  // Configured humans who have not joined by invite yet are skipped until they do.
  const humans = ctx.index.config.review.humanReviewers.filter(
    (id) => id !== task.assignee && ctx.index.kindOf(id) === 'human',
  );
  const everyone = [...new Set([...agents, ...humans])];
  repos.reviews.addReviewers(task.id, round, everyone);

  if (everyone.length === 0) {
    const tell = [task.assignee, task.createdBy].filter(
      (id): id is string => !!id && ctx.index.kindOf(id) !== undefined,
    );
    if (tell.length > 0) {
      const noteForCaller = `No reviewer was found for ${taskKey(task.id)}; request one with request_review.`;
      env.post(
        {
          threadId: task.threadId,
          senderId: deps.messaging.hubId,
          kind: 'review',
          body: noReviewerText(task),
          to: [...new Set(tell)],
          refs: { action: 'no_reviewer' },
        },
        { noteForCaller },
      );
    }
  }
  for (const reviewer of everyone) {
    const inactive = ctx.index.kindOf(reviewer) === 'agent' && !deps.presence.isOnline(reviewer);
    env.post({
      threadId: task.threadId,
      senderId: deps.messaging.hubId,
      kind: 'review',
      body: reviewRequestText(task, round, inactive ? ctx.index.displayName(reviewer) : null),
      to: [reviewer],
      trust: task.trust,
      refs: { action: 'review_requested', ...(task.prUrl ? { prUrl: task.prUrl } : {}) },
    });
  }
  if (ctx.index.config.review.requiredApprovals === 0) env.applySystem(task.id, 'approve', {});
};

function chooseAgents(env: EffectEnv, task: TaskRecord, round: number): string[] {
  // Pinned reviewers who have since left the team fall through to the next source.
  const pinned = env.repos.reviews
    .reviewers(task.id, 0)
    .filter((id) => env.ctx.index.kindOf(id) !== undefined);
  if (pinned.length > 0) return pinned;
  if (round > 1) {
    const previous = env.repos.reviews.reviewers(task.id, round - 1);
    const agentsOnly = previous.filter((id) => env.ctx.index.kindOf(id) === 'agent');
    if (agentsOnly.length > 0) return agentsOnly;
  }
  const { index } = env.ctx;
  return selectReviewers({
    exclude: [task.assignee, task.createdBy === task.assignee ? task.createdBy : null].filter(
      (id): id is string => id !== null,
    ),
    areaOwners: task.area ? (index.area(task.area)?.owners ?? []) : [],
    skills: taskSkills(index, task),
    agents: index.agents(),
    isOnline: (id) => env.deps.presence.isOnline(id),
    load: env.views.activeLoad(),
    max: index.config.review.maxReviewers,
  });
}
