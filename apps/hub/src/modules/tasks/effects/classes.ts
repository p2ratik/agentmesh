import type { WorkflowState } from '@agentmesh/config';
import type { DeliveryClass } from '@agentmesh/protocol';
import type { TaskRecord } from '../repo';

/*
 * Which task notices interrupt their recipient (`action`) and which ride along
 * later (`status`). Notices not listed here keep the post default, `action`:
 * review requests, "no reviewer found" and "dependencies done" are all a next
 * step. Board offers are optional work: `status`.
 */

/** The transition summary: only the agent the task was just taken from has to stop. */
export function summaryClass(recipientId: string, takenFrom: string | null): DeliveryClass {
  return recipientId === takenFrom ? 'action' : 'status';
}

/**
 * Every assignee brief is a next step (start, fix, merge) or a reason to stop
 * (cancelled). A team's own workflow states get the same, so none is downgraded by mistake.
 */
export function assigneeNoticeClass(_action: string | null): DeliveryClass {
  return 'action';
}

/** A blocked task may need its creator; a finished one leaves them nothing to do. */
export function creatorNoticeClass(
  state: Pick<WorkflowState, 'terminal'> | undefined,
): DeliveryClass {
  return state?.terminal ? 'status' : 'action';
}

/** A verdict is the assignee's next step; everyone else is following along. */
export function reviewSubmittedClass(
  recipientId: string,
  task: Pick<TaskRecord, 'assignee'>,
): DeliveryClass {
  return recipientId === task.assignee ? 'action' : 'status';
}
