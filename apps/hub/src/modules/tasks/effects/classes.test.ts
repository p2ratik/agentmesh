import type { DeliveryClass } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import {
  assigneeNoticeClass,
  creatorNoticeClass,
  reviewSubmittedClass,
  summaryClass,
} from './classes';

const task = { assignee: 'alice-agent' };
const accepted = { action: 'accept', assignee: 'alice-agent', takenFrom: null };
const reassigned = { action: 'assign', assignee: 'alice-agent', takenFrom: 'bob-agent' };
const unblocked = { action: 'unblock', assignee: 'alice-agent', takenFrom: null };

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
