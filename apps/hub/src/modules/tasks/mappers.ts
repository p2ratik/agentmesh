import type { Task } from '@agentmesh/protocol';
import { optionalKey, taskKey, threadKey } from '../../core/ids';
import type { TaskRecord } from './repo';

/** Facts that live outside the `tasks` row. */
export interface TaskExtras {
  terminal: boolean;
  /** Reviewers of the current round. */
  reviewers: string[];
  /** Internal ids of the tasks this one waits for. */
  dependsOn: number[];
}

/** Converts a stored task into its protocol shape (string ids). */
export function toTask(record: TaskRecord, extras: TaskExtras): Task {
  return {
    id: taskKey(record.id),
    title: record.title,
    description: record.description,
    workflow: record.workflow,
    state: record.state,
    terminal: extras.terminal,
    priority: record.priority,
    labels: record.labels,
    repo: record.repo,
    area: record.area,
    baseBranch: record.baseBranch,
    branch: record.branch,
    prUrl: record.prUrl,
    doneWhen: record.doneWhen,
    assignee: record.assignee,
    reviewers: extras.reviewers,
    reviewRound: record.reviewRound,
    createdBy: record.createdBy,
    planId: optionalKey('plan', record.planId),
    threadId: threadKey(record.threadId),
    dependsOn: extras.dependsOn.map(taskKey),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
