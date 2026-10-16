import type { WorkflowInput } from '../schema/workflow';

/**
 * Default engineering workflow: route → accept → build on a task branch →
 * PR into the integration branch → peer review → merge → done.
 * Teams can override it by defining a workflow with the same id.
 */
export const FEATURE_WORKFLOW: WorkflowInput = {
  id: 'feature',
  description: 'Implement a change on a task branch, get it peer-reviewed, merge it.',
  initial: 'backlog',
  states: {
    backlog: { label: 'Backlog', onEnter: ['auto_assign'] },
    assigned: { label: 'Assigned', onEnter: ['notify_assignee'] },
    in_progress: { label: 'In progress' },
    blocked: { label: 'Blocked', onEnter: ['notify_creator'] },
    in_review: { label: 'In review', onEnter: ['request_reviews'] },
    changes_requested: { label: 'Changes requested', onEnter: ['notify_assignee'] },
    approved: { label: 'Approved', onEnter: ['notify_assignee'] },
    done: {
      label: 'Done',
      terminal: true,
      onEnter: ['release_leases', 'release_dependents', 'notify_creator', 'close_thread'],
    },
    cancelled: {
      label: 'Cancelled',
      terminal: true,
      onEnter: ['release_leases', 'notify_assignee', 'close_thread'],
    },
  },
  transitions: [
    {
      action: 'assign',
      from: ['backlog', 'assigned'],
      to: 'assigned',
      by: ['system', 'human', 'creator'],
      requires: ['to'],
    },
    { action: 'claim', from: ['backlog'], to: 'assigned', by: ['agent'] },
    { action: 'accept', from: ['assigned'], to: 'in_progress', by: ['assignee'] },
    {
      action: 'decline',
      from: ['assigned'],
      to: 'backlog',
      by: ['assignee'],
      requires: ['note'],
      effects: ['clear_assignee'],
    },
    {
      action: 'handoff',
      from: ['assigned', 'in_progress', 'blocked'],
      to: 'assigned',
      by: ['assignee'],
      requires: ['to', 'note'],
    },
    { action: 'block', from: ['in_progress'], to: 'blocked', by: ['assignee'], requires: ['note'] },
    {
      action: 'unblock',
      from: ['blocked'],
      to: 'in_progress',
      by: ['assignee', 'creator', 'human'],
    },
    {
      action: 'submit',
      from: ['in_progress', 'changes_requested'],
      to: 'in_review',
      by: ['assignee'],
      requires: ['prUrl'],
    },
    { action: 'approve', from: ['in_review'], to: 'approved', by: ['system'] },
    { action: 'request_changes', from: ['in_review'], to: 'changes_requested', by: ['system'] },
    { action: 'complete', from: ['approved'], to: 'done', by: ['assignee', 'human'] },
    { action: 'cancel', from: '*', to: 'cancelled', by: ['creator', 'human'] },
  ],
};

/** A stand-alone review of an existing PR. The requester is the assignee. */
export const REVIEW_WORKFLOW: WorkflowInput = {
  id: 'review',
  description: 'Peer review of an existing pull request.',
  initial: 'in_review',
  states: {
    in_review: { label: 'In review', onEnter: ['request_reviews'] },
    changes_requested: { label: 'Changes requested', onEnter: ['notify_assignee'] },
    approved: { label: 'Approved', onEnter: ['notify_assignee'] },
    done: { label: 'Done', terminal: true, onEnter: ['close_thread'] },
    cancelled: { label: 'Cancelled', terminal: true, onEnter: ['close_thread'] },
  },
  transitions: [
    { action: 'approve', from: ['in_review'], to: 'approved', by: ['system'] },
    { action: 'request_changes', from: ['in_review'], to: 'changes_requested', by: ['system'] },
    { action: 'submit', from: ['changes_requested'], to: 'in_review', by: ['assignee'] },
    {
      action: 'complete',
      from: ['approved', 'changes_requested', 'in_review'],
      to: 'done',
      by: ['assignee', 'human'],
    },
    { action: 'cancel', from: '*', to: 'cancelled', by: ['creator', 'human'] },
  ],
};

export const BUILTIN_WORKFLOWS: readonly WorkflowInput[] = [FEATURE_WORKFLOW, REVIEW_WORKFLOW];
