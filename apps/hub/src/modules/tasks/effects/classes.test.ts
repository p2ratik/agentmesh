import type { DeliveryClass } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import {
  assigneeNoticeClass,
  creatorNoticeClass,
  reviewSubmittedClass,
  summaryClass,
} from './classes';

const task = { assignee: 'alice-agent' };
const change = { assignee: 'alice-agent', takenFrom: null, terminal: false, pendingReviewers: [] };
const accepted = { ...change, action: 'accept' };
const reassigned = { ...change, action: 'assign', takenFrom: 'bob-agent' };
const unblocked = { ...change, action: 'unblock' };
const cancelled = {
  ...change,
  action: 'cancel',
  terminal: true,
  pendingReviewers: ['carol-agent'],
};
const reviewing = { ...change, action: 'block', pendingReviewers: ['carol-agent'] };

const rows: Array<[site: string, expected: DeliveryClass, actual: () => DeliveryClass]> = [
  ['summary, to a participant', 'status', () => summaryClass('bob-agent', accepted)],
  [
    'summary, to the agent the task was taken from',
    'action',
    () => summaryClass('bob-agent', reassigned),
  ],
  [
    'summary, to others when it was taken from someone',
    'status',
    () => summaryClass('carol-agent', reassigned),
  ],
  [
    'summary of an unblock, to the assignee',
    'action',
    () => summaryClass('alice-agent', unblocked),
  ],
  ['summary of an unblock, to anyone else', 'status', () => summaryClass('bob-agent', unblocked)],
  [
    'summary of a terminal state, to a reviewer owing a verdict',
    'action',
    () => summaryClass('carol-agent', cancelled),
  ],
  ['summary of a terminal state, to anyone else', 'status', () => summaryClass('dan', cancelled)],
  [
    'summary of a non-terminal state, to a reviewer owing a verdict',
    'status',
    () => summaryClass('carol-agent', reviewing),
  ],
  ['review submitted, to the assignee', 'action', () => reviewSubmittedClass('alice-agent', task)],
  ['review submitted, to anyone else', 'status', () => reviewSubmittedClass('bob-agent', task)],
  ['assignee brief: assigned', 'action', () => assigneeNoticeClass('assign')],
  ['assignee brief: assigned at creation', 'action', () => assigneeNoticeClass(null)],
  ['assignee brief: changes requested', 'action', () => assigneeNoticeClass('request_changes')],
  ['assignee brief: approved', 'action', () => assigneeNoticeClass('approve')],
  ['assignee brief: cancelled', 'action', () => assigneeNoticeClass('cancel')],
  ['creator update: blocked', 'action', () => creatorNoticeClass({ terminal: false })],
  ['creator update: done', 'status', () => creatorNoticeClass({ terminal: true })],
];

describe('task notice classes', () => {
  it.each(rows)('%s → %s', (_site, expected, actual) => {
    expect(actual()).toBe(expected);
  });
});
