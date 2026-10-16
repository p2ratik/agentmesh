import { ConfigIndex, configFromObject } from '@agentmesh/config';
import type { DomainEventData, MeshMessage, Plan, ThreadSummary } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { renderExternalReceived } from './external';
import { threadTitle, webhookUsername } from './format';
import { renderMessageCreated } from './message';
import { renderPlanChanged } from './plan';
import { renderTaskChanged } from './task';

const index = new ConfigIndex(
  configFromObject({
    version: 1,
    mesh: { name: 'acme' },
    humans: [{ id: 'alice', displayName: 'Alice', discordUserId: '100000000000000001' }],
    agents: [{ id: 'alice-agent', owner: 'alice', avatarUrl: 'https://img/a.png' }],
  }).config,
);

const thread = (kind: ThreadSummary['kind']): ThreadSummary => ({
  id: 'thr-3',
  kind,
  subject: 'Render queue retries',
  createdBy: 'alice-agent',
  createdAt: '',
  updatedAt: '',
  depth: 0,
  parentId: null,
  participants: ['alice-agent', 'alice'],
  taskId: null,
  planId: null,
  status: 'open',
  messageCount: 1,
});

const message = (extra: Partial<MeshMessage> = {}): MeshMessage => ({
  id: 'msg-1',
  threadId: 'thr-3',
  kind: 'ask',
  from: { id: 'alice-agent', kind: 'agent', displayName: "Alice's agent" },
  to: ['alice'],
  subject: 'Render queue retries',
  body: 'Can we drop the v1 endpoint?',
  status: null,
  trust: 'team',
  depth: 0,
  refs: {},
  createdAt: '2026-10-16T09:00:00.000Z',
  ...extra,
});

describe('message rendering', () => {
  it('posts into the mirrored thread under the participant name and avatar', () => {
    const [intent] = renderMessageCreated(
      { message: message(), thread: thread('conversation') },
      index,
    );
    expect(intent).toMatchObject({
      purpose: 'council',
      username: "Alice's agent",
      avatarURL: 'https://img/a.png',
      thread: { threadId: 'thr-3', title: 'thr-3 · Render queue retries' },
    });
    expect(intent?.content).toContain('**[ask]**');
    expect(intent?.mentionUserIds).toBeUndefined();
  });

  it('pings the human on escalations and flags external content', () => {
    const [intent] = renderMessageCreated(
      {
        message: message({ kind: 'escalation', status: 'needs_human', trust: 'external' }),
        thread: thread('escalation'),
      },
      index,
    );
    expect(intent?.purpose).toBe('escalations');
    expect(intent?.mentionUserIds).toEqual(['100000000000000001']);
    expect(intent?.content).toMatch(
      /^<@100000000000000001>\n🌐 external content · \*\*\[escalation\]\*\* → Alice · 🙋 needs human/,
    );
  });

  it('keeps names within Discord limits and away from reserved words', () => {
    expect(threadTitle('thr-1', 'x'.repeat(300)).length).toBeLessThanOrEqual(100);
    expect(
      webhookUsername({ id: 'discord-bridge', kind: 'service', displayName: 'Discord Bridge' }),
    ).toBe('Bridge');
  });
});

describe('plan and task rendering', () => {
  const plan: Plan = {
    id: 'plan-2',
    topic: 'Render status',
    state: 'awaiting_approval',
    initiator: 'alice',
    facilitator: 'alice-agent',
    participants: ['alice-agent'],
    threadId: 'thr-9',
    rounds: [{ id: 'proposals', title: 'Proposals', prompt: '', minutes: 30 }],
    roundIndex: 0,
    currentRound: null,
    deadline: null,
    requireApproval: true,
    summary: 'Enum it.',
    drafts: [{ key: 'api', title: 'Status enum', description: '', area: 'api' }],
    taskIds: [],
    createdAt: '',
    updatedAt: '',
  };

  it('asks for approval with buttons and pings the initiator', () => {
    const [intent] = renderPlanChanged(
      { plan, from: 'synthesizing', to: 'awaiting_approval', round: null },
      index,
    );
    expect(intent?.buttons?.map((b) => b.customId)).toEqual([
      'plan:approve:plan-2',
      'plan:cancel:plan-2',
    ]);
    expect(intent?.mentionUserIds).toEqual(['100000000000000001']);
    expect(intent?.content).toContain('**Status enum** `api`');
  });

  it('announces review transitions in reviews as well as events', () => {
    const task = {
      id: 'task-4',
      title: 'Retries',
      prUrl: 'https://x/pr/4',
      reviewers: ['bob-agent'],
    };
    const intents = renderTaskChanged({
      task: task as DomainEventData<'task.changed'>['task'],
      action: 'submit',
      from: 'in_progress',
      to: 'in_review',
      actor: 'alice-agent',
      note: null,
    });
    expect(intents.map((i) => i.purpose)).toEqual(['events', 'reviews']);
    expect(intents[1]?.content).toContain('reviewers bob-agent');
  });

  it('keeps unmatched low-severity external events out of alerts', () => {
    const event = {
      id: 'x:1',
      source: 'hermes',
      type: 'cron.tick',
      severity: 'info' as const,
      payload: {},
      receivedAt: '',
    };
    expect(renderExternalReceived({ event, matchedRules: [] })).toEqual([]);
    expect(
      renderExternalReceived({ event: { ...event, severity: 'error' }, matchedRules: [] }),
    ).toHaveLength(1);
  });
});
