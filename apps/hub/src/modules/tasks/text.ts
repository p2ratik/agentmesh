import { redactSecrets, slugify } from '@agentmesh/common';
import { type ConfigIndex, renderBranchName } from '@agentmesh/config';
import type { TaskReview } from '@agentmesh/protocol';
import { taskKey } from '../../core/ids';
import type { TaskRecord } from './repo';
import type { NextAction } from './types';

/**
 * Message bodies the task module sends. Written for a Claude Code agent:
 * lead with the task id and title, end with the exact tool call to make next.
 */

const head = (task: TaskRecord): string => `**${taskKey(task.id)} · ${task.title}**`;

/** One line per available action, as a ready-to-use tool call. */
export function nextActionsText(task: TaskRecord, actions: readonly NextAction[]): string {
  if (actions.length === 0) return '';
  const id = taskKey(task.id);
  const lines = actions.map((a) => {
    const args = [`task_id: "${id}"`, `action: "${a.action}"`, ...a.missing.map(argFor)];
    return `- \`task_act(${args.join(', ')})\``;
  });
  return `Next:\n${lines.join('\n')}`;
}

const argFor = (field: string): string => {
  if (field === 'prUrl') return 'pr_url: "<PR url>"';
  if (field === 'to') return 'to: "<agent id>"';
  return `${field}: "<${field}>"`;
};

/** The slug is cut from the title, so the title is redacted first: a cut token no longer matches. */
export function suggestedBranch(index: ConfigIndex, task: TaskRecord, agentId: string): string {
  const owner = index.agent(agentId)?.owner ?? agentId;
  return renderBranchName(index.config.git.branchTemplate, {
    owner,
    agent: agentId,
    task: taskKey(task.id),
    slug: slugify(redactSecrets(task.title)),
  });
}

const baseBranchOf = (index: ConfigIndex, task: TaskRecord): string =>
  task.baseBranch ?? index.config.git.integrationBranch;

/** An agent's own assignment, as a note on its result: the git part of the brief it doesn't get. */
export function branchNote(index: ConfigIndex, task: TaskRecord, assignee: string): string {
  const branch = suggestedBranch(index, task, assignee);
  return `${taskKey(task.id)}: base branch \`${baseBranchOf(index, task)}\` · suggested branch \`${branch}\` · work in a separate git worktree.`;
}

export function createdText(task: TaskRecord, creatorName: string): string {
  const facts = factsLine(task);
  const description = task.description ? `\n\n${task.description}` : '';
  return `${head(task)} created by ${creatorName}${facts ? `\n${facts}` : ''}${description}`;
}

export function transitionText(input: {
  task: TaskRecord;
  action: string;
  from: string;
  to: string;
  actorName: string;
  note: string | null;
}): string {
  const { task, action, from, to, actorName, note } = input;
  const assignee = task.assignee && ['assign', 'handoff', 'claim'].includes(action);
  const lines = [
    `${head(task)}: ${from} → ${to} (${action} by ${actorName})`,
    assignee ? `Assignee: ${task.assignee}` : '',
    action === 'submit' && task.prUrl ? `PR: ${task.prUrl}` : '',
    note ? `> ${note.replace(/\n/g, '\n> ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export interface AssignmentBriefInput {
  task: TaskRecord;
  index: ConfigIndex;
  assignee: string;
  dependencies: Array<{ record: TaskRecord; done: boolean }>;
  next: readonly NextAction[];
}

export function assignmentBrief({
  task,
  index,
  assignee,
  dependencies,
  next,
}: AssignmentBriefInput): string {
  const base = baseBranchOf(index, task);
  const waiting = dependencies.filter((d) => !d.done);
  const lines = [
    `${head(task)} is assigned to you.`,
    factsLine(task),
    `Base branch: \`${base}\` · suggested branch: \`${suggestedBranch(index, task, assignee)}\``,
    "Work in a fresh git worktree for this task; never touch your human's working checkout.",
    task.doneWhen ? `Done when: ${task.doneWhen}` : '',
    dependencies.length > 0
      ? `Depends on: ${dependencies.map((d) => `${taskKey(d.record.id)} (${d.record.state})`).join(', ')}`
      : '',
    waiting.length > 0 ? "Don't start until those dependencies are done — you'll be told." : '',
    task.description ? `\n${task.description}\n` : '',
    nextActionsText(task, next),
  ];
  return lines.filter(Boolean).join('\n');
}

export function changesRequestedBrief(
  task: TaskRecord,
  reviews: readonly TaskReview[],
  next: readonly NextAction[],
): string {
  const verdicts = reviews
    .filter((r) => r.verdict !== 'comment')
    .map((r) => `- ${r.reviewer}: ${r.verdict.replace('_', ' ')}`);
  return [
    `${head(task)}: changes requested (review round ${task.reviewRound}).`,
    verdicts.join('\n'),
    'Read the reviews in this thread (or task_get), push fixes to the same branch, then resubmit.',
    nextActionsText(task, next),
  ]
    .filter(Boolean)
    .join('\n');
}

export function approvedBrief(
  task: TaskRecord,
  index: ConfigIndex,
  next: readonly NextAction[],
): string {
  const git = index.config.git;
  const target = task.baseBranch ?? git.integrationBranch;
  const may = git.agentsMayMergeInto.length > 0 ? git.agentsMayMergeInto.join(', ') : 'none';
  const allowed = git.agentsMayMergeInto.includes(target);
  return [
    `${head(task)} is approved.`,
    allowed
      ? `Merge ${task.prUrl ?? 'your PR'} into \`${target}\` once CI is green, then complete the task.`
      : `\`${target}\` needs a human to merge (agents may merge into: ${may}). Ask with escalate, then complete.`,
    nextActionsText(task, next),
  ]
    .filter(Boolean)
    .join('\n');
}

export function stateBrief(task: TaskRecord, label: string, next: readonly NextAction[]): string {
  return [`${head(task)} is now ${label}.`, nextActionsText(task, next)].filter(Boolean).join('\n');
}

export function creatorUpdate(
  task: TaskRecord,
  action: string,
  to: string,
  actorName: string,
): string {
  return `${head(task)} → ${to} (${action} by ${actorName})${task.prUrl && action === 'submit' ? `\nPR: ${task.prUrl}` : ''}`;
}

/** `inactive` names a reviewer with no active session, so the humans watching notice. */
export function reviewRequestText(
  task: TaskRecord,
  round: number,
  inactive: string | null = null,
): string {
  const id = taskKey(task.id);
  return [
    `Review requested: ${head(task)} (round ${round})`,
    inactive
      ? `⏸ ${inactive} has no active session right now; this waits until one is activated.`
      : '',
    task.prUrl ? `PR: ${task.prUrl}` : '',
    task.branch ? `Branch: \`${task.branch}\`` : '',
    task.description ? `Focus / context:\n${task.description}` : '',
    'Review the diff (e.g. `gh pr diff`), run the tests, and leave findings as PR comments.',
    `Then: \`review_submit(task_id: "${id}", verdict: "approve" | "request_changes" | "comment", body: "<summary>")\``,
  ]
    .filter(Boolean)
    .join('\n');
}

export function reviewSubmittedText(
  task: TaskRecord,
  review: TaskReview,
  reviewerName: string,
): string {
  const badge = {
    approve: '✅ approved',
    request_changes: '🔁 changes requested',
    comment: '💬 commented',
  }[review.verdict];
  return `${head(task)} — ${badge} by ${reviewerName} (round ${review.round})\n\n${review.body}`;
}

export function noReviewerText(task: TaskRecord): string {
  return `${head(task)}: no reviewer is available right now. Ask someone directly with ask/request_review, or escalate.`;
}

export function boardText(task: TaskRecord): string {
  return [
    `${head(task)} has no owner yet.`,
    factsLine(task),
    `If it fits your skills and load, claim it: \`task_act(task_id: "${taskKey(task.id)}", action: "claim")\``,
  ]
    .filter(Boolean)
    .join('\n');
}

export function dependenciesDoneText(task: TaskRecord): string {
  return `${head(task)}: all dependencies are done — you can start now.`;
}

function factsLine(task: TaskRecord): string {
  return [
    `priority ${task.priority}`,
    task.repo ? `repo ${task.repo}` : '',
    task.area ? `area ${task.area}` : '',
    task.labels.length > 0 ? `labels ${task.labels.join(', ')}` : '',
    task.prUrl ? `PR ${task.prUrl}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
