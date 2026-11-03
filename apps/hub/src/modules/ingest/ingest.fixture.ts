// The ingest service test setup: a team with areas, two ingest sources and four rules.
import { testTeamConfig } from '../../testing/fixtures';
import { createServiceHarness } from '../../testing/services';
import { TaskServiceImpl } from '../tasks/tasks.service';
import { IngestServiceImpl } from './ingest.service';

export const GITHUB_SECRET = 'github-secret-0123456789';

export function setup(overrides: Record<string, unknown> = {}) {
  const loaded = testTeamConfig({
    ...overrides,
    areas: [
      {
        id: 'api',
        repos: ['acme/api'],
        owners: ['alice-agent', 'carol-agent'],
        skills: ['backend'],
      },
      { id: 'web', repos: ['acme/web'], owners: ['bob-agent'], skills: ['frontend'] },
      // dana-agent joins by invite later.
      { id: 'ops', owners: ['dana-agent'], skills: ['infra'] },
    ],
    ingest: {
      sources: [
        { id: 'hermes', auth: { type: 'bearer', token: 'test-token-0123456789abcdef' } },
        {
          id: 'github',
          format: 'raw',
          typeHeader: 'x-github-event',
          typeField: 'action',
          idHeader: 'x-github-delivery',
          auth: { type: 'hmac-sha256', secret: GITHUB_SECRET },
        },
      ],
    },
    rules: [
      {
        id: 'ci-failed',
        match: {
          source: 'github',
          type: 'workflow_run.*',
          where: { 'payload.conclusion': { equals: 'failure' } },
        },
        throttle: { key: '{{payload.branch}}', windowMinutes: 30 },
        actions: [
          { create_task: { title: 'Fix CI on {{payload.branch}}', repo: '{{payload.repo}}' } },
          { notice: { channel: 'alerts', text: 'CI failed on {{payload.branch}}' } },
        ],
      },
      {
        id: 'quiet-fyi',
        match: { source: 'hermes', type: 'fyi.*' },
        actions: [{ notify: { to: ['bob-agent'], text: 'FYI {{summary}}', class: 'status' } }],
      },
      {
        id: 'plain-notify',
        match: { source: 'hermes', type: 'plain.*' },
        actions: [{ notify: { to: ['bob-agent'], text: 'Heads up {{summary}}' } }],
      },
      {
        id: 'errors-to-owners',
        match: { source: 'hermes', minSeverity: 'error' },
        actions: [
          { notify: { to: 'area-owners', area: '{{payload.area}}', text: 'Spike: {{summary}}' } },
        ],
      },
    ],
  });
  const h = createServiceHarness(loaded, { online: ['alice-agent', 'bob-agent', 'carol-agent'] });
  const tasks = new TaskServiceImpl(h.ctx, {
    messaging: h.messaging,
    presence: h.presence,
    leases: h.leases,
  });
  h.presence.setLoadReader(() => tasks.activeLoad());
  const ingest = new IngestServiceImpl(h.ctx, {
    messaging: h.messaging,
    tasks,
    presence: h.presence,
  });
  return { ...h, tasks, ingest, loaded };
}
