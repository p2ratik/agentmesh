import type { Plan } from '@agentmesh/protocol';
import { planKey, taskKey, threadKey } from '../../core/ids';
import type { PlanRecord } from './plans.repo';

/** The id of the step a plan is in: a round id, `synthesis`, or null when not running. */
export function currentStep(plan: PlanRecord): string | null {
  if (plan.state === 'collecting') return plan.rounds[plan.roundIndex]?.id ?? null;
  return plan.state === 'synthesizing' ? 'synthesis' : null;
}

export function toPlan(plan: PlanRecord): Plan {
  return {
    id: planKey(plan.id),
    topic: plan.topic,
    state: plan.state,
    initiator: plan.initiator,
    facilitator: plan.facilitator,
    participants: plan.participants,
    threadId: threadKey(plan.threadId),
    rounds: plan.rounds,
    roundIndex: plan.roundIndex,
    currentRound: currentStep(plan),
    deadline: plan.deadline,
    requireApproval: plan.requireApproval,
    summary: plan.summary,
    drafts: plan.drafts,
    taskIds: plan.taskIds.map(taskKey),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}
