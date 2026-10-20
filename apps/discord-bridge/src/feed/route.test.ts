import { ConfigIndex, configFromObject } from '@agentmesh/config';
import type { DomainEvent, Plan } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { PostIntent } from '../render/intents';
import { routeEvent } from './route';

/** Assembled at runtime so repository secret scanners never flag this file. */
const TOKEN = ['ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('');

const index = new ConfigIndex(
  configFromObject({
    version: 1,
    mesh: { name: 'acme' },
    humans: [{ id: 'alice', displayName: 'Alice', discordUserId: '100000000000000001' }],
    agents: [{ id: 'alice-agent', owner: 'alice' }],
  }).config,
);

const feed = (type: DomainEvent['type'], data: unknown): DomainEvent =>
  ({ id: 'evt-1', type, at: '2026-10-20T09:00:00.000Z', data }) as DomainEvent;

/** Every string the posts would put on Discord. */
const posted = (intents: PostIntent[]): string =>
  intents
    .flatMap((i) => [i.content, i.username ?? '', i.thread?.title ?? '', i.thread?.starter ?? ''])
    .join('\n');

const expectRedacted = (intents: PostIntent[]) => {
  expect(intents.length).toBeGreaterThan(0);
  const text = posted(intents);
  // Not even a prefix of the token may survive (renderers truncate).
  expect(text).not.toContain('ghp_');
  expect(text).toContain('[REDACTED]');
};

const task = (title: string) => ({
  id: 'task-9',
  title,
  createdBy: 'alice-agent',
  area: null,
  repo: null,
  assignee: null,
  priority: 'normal',
  reviewers: [],
  prUrl: null,
});

const plan = (extra: Partial<Plan>): Plan => ({
  id: 'plan-3',
  topic: 'Billing v2',
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
  summary: null,
  drafts: [],
  taskIds: [],
  createdAt: '',
  updatedAt: '',
  ...extra,
});

describe('routeEvent masks secrets in everything it posts', () => {
  it('in task titles, also where the renderer truncates through the token', () => {
    expectRedacted(routeEvent(feed('task.created', { task: task(`Rotate ${TOKEN}`) }), index));
    // The review announcement shows oneLine(title, 120), which would cut this token after
    // 16 characters, too short for the token pattern.
    const long = `Rotate the deploy key ${'a'.repeat(80)} ${TOKEN}`;
    const changed = {
      task: task(long),
      action: 'submit',
      from: 'in_progress',
      to: 'in_review',
      actor: 'alice-agent',
      note: null,
    };
    expectRedacted(routeEvent(feed('task.changed', changed), index));
  });

  it('in plan topics (thread titles and starters), summaries and draft titles', () => {
    const topic = `Move ${TOKEN} to the vault`;
    expectRedacted(
      routeEvent(feed('plan.started', { plan: plan({ topic, state: 'collecting' }) }), index),
    );
    const synthesized = plan({
      summary: `Use ${TOKEN} for the webhook`,
      drafts: [{ key: 'ci', title: `Rotate ${TOKEN}`, description: '', area: 'api' }],
    });
    const changed = {
      plan: synthesized,
      from: 'synthesizing',
      to: 'awaiting_approval',
      round: null,
    };
    expectRedacted(routeEvent(feed('plan.changed', changed), index));
  });

  it('in external events', () => {
    const external = {
      event: {
        id: 'x:1',
        source: 'github',
        type: 'workflow_run.failed',
        severity: 'error',
        summary: `Build failed: export GITHUB_TOKEN=${TOKEN}`,
        payload: {},
        receivedAt: '',
      },
      matchedRules: [],
    };
    expectRedacted(routeEvent(feed('external.received', external), index));
  });

  it('leaves ordinary text alone', () => {
    const [intent] = routeEvent(
      feed('task.created', { task: task('Add retries to the queue') }),
      index,
    );
    expect(intent?.content).toContain('Add retries to the queue');
    expect(intent?.content).not.toContain('[REDACTED]');
  });
});

describe('routeEvent masks without mangling the post', () => {
  const external = (extra: Record<string, unknown>) => ({
    event: {
      id: 'x:1',
      source: 'github',
      type: 'workflow_run.failed',
      severity: 'error',
      payload: {},
      receivedAt: '',
      ...extra,
    },
    matchedRules: [],
  });

  it('keeps the brackets of a link whose query string was masked', () => {
    const url = 'https://ci.example.com/run/7?token=abc123def456';
    const [intent] = routeEvent(feed('external.received', external({ url })), index);
    expect(intent?.content).toContain('<https://ci.example.com/run/7?token=[REDACTED]>');
  });

  it('does not mask the words after an id that contains a keyword', () => {
    const created = { task: { ...task('Fix flaky retries'), createdBy: 'ci-token-bot' } };
    const [intent] = routeEvent(feed('task.created', created), index);
    expect(intent?.content).toContain('ci-token-bot: Fix flaky retries');
  });

  it('posts a notice as the hub composed it: the hub masks each template value', () => {
    // Masking the finished text matched across the alarm name and the summary.
    const text = '🚨 AWS alarm SecretsManagerRotationFailed: High error rate on api';
    const notice = { channel: 'alerts', text, severity: 'error' };
    const [intent] = routeEvent(feed('notice.posted', notice), index);
    expect(intent?.content).toContain(text);
  });

  it('never scans the raw webhook payload, which nothing renders', () => {
    // Outsiders write payloads (up to 1 MB). Masking reads every property, so this throws if it runs.
    const payload = {
      get body(): string {
        throw new Error('payload was scanned');
      },
    };
    expect(() => routeEvent(feed('external.received', external({ payload })), index)).not.toThrow();
  });
});
