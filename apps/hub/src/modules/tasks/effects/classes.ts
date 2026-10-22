import type { WorkflowState } from '@agentmesh/config';
import type { DeliveryClass } from '@agentmesh/protocol';
import type { TaskRecord } from '../repo';

/*
 * Which task notices interrupt their recipient (`action`) and which ride along
 * later (`status`). Notices not listed here keep the post default, `action`:
 * review requests, "no reviewer found" and "dependencies done" are all a next
 * step. Board offers are optional work: `status`.
 */

/** What the transition summary needs to know about the change. */
export interface SummaryChange {
  action: string;
  /** The assignee after the transition. */
  assignee: string | null;
  /** The previous assignee, when an `assign`, `handoff` or `claim` moved the task to someone else. */
  takenFrom: string | null;
  /** The transition ended the task (a terminal state, such as cancelled or done). */
  terminal: boolean;
  /** Reviewers of the current round who have not given a verdict yet. */
  pendingReviewers: readonly string[];
}

/**
 * The transition summary is status, except where it gives a next step or a
 * reason to stop: the agent the task was just taken from has to stop, so does
 * a reviewer still owing a verdict when the task ends, and the assignee of a
 * task someone else unblocked can resume.
 */
export function summaryClass(recipientId: string, change: SummaryChange): DeliveryClass {
  if (recipientId === change.takenFrom) return 'action';
  if (change.terminal && change.pendingReviewers.includes(recipientId)) return 'action';
  return change.action === 'unblock' && recipientId === change.assignee ? 'action' : 'status';
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
