import type { IngestSource } from '@agentmesh/config';
import type { IngestEvent } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../../contracts';
import { internalId } from '../../core/ids';
import { testTeamConfig } from '../../testing/fixtures';
import { createServiceHarness } from '../../testing/services';
import { TaskServiceImpl } from '../tasks/tasks.service';
import { normalizeEvent } from './http/normalize';
import { IngestServiceImpl } from './ingest.service';

/** Assembled at runtime so repository secret scanners never flag this file. */
const TOKEN = ['ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('');

const alice: Actor = { id: 'alice', kind: 'human', roles: ['admin'] };
const PER_VALUE = '{{payload.alarm}}: {{summary}}';

function setup() {
  const loaded = testTeamConfig({
    ingest: {
      sources: [{ id: 'hermes', auth: { type: 'bearer', token: 'test-token-0123456789abcdef' } }],
    },
    rules: [
      {
        id: 'rotation',
        match: { source: 'hermes', type: 'secret.rotation' },
        throttle: { key: '{{payload.secret_arn}}', windowMinutes: 30 },
        actions: [
          { notify: { to: 'all-agents', subject: PER_VALUE, text: '{{summary}}' } },
          { create_task: { title: PER_VALUE } },
        ],
      },
      {
        id: 'fallbacks',
        match: { source: 'hermes', type: 'deploy.*' },
        actions: [
          { notify: { to: 'all-agents', text: 'deploy' } },
          { create_task: { title: '{{payload.none}}' } },
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
  const subject = (threadKey: string) =>
    h.messaging.thread(internalId('thread', threadKey)).subject;
  return { ...h, tasks, ingest, subject };
}

const rotation = (id: string, secret: string): IngestEvent => ({
  id,
  type: 'secret.rotation',
  severity: 'error',
  summary: 'Rotation failed for prod-db',
  payload: {
    alarm: 'SecretsManagerRotationFailed',
    secret_arn: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${secret}`,
  },
});

// Only in the hub and the inbox: where the bridge and post() publish these, they mask the whole
// title, subject or body again (see docs/security.md).
describe('the hub keeps a rule’s per-value masking in subjects and titles', () => {
  it('in a notify subject and a create_task title', async () => {
    const s = setup();
    await s.ingest.accept('hermes', rotation('r1', 'prod/db-AbCdEf'));
    // createThread masked the finished subject again: "…Failed: [REDACTED] failed for prod-db".
    const expected = 'SecretsManagerRotationFailed: Rotation failed for prod-db';
    const task = s.tasks.get(1, alice);
    expect(task.title).toBe(expected);
    expect(s.subject(task.threadId)).toBe(expected);
    const notified = (await s.drain()).get('bob-agent') ?? [];
    expect(notified.map((m) => m.subject)).toContain(expected);
  });

  it('throttles on the raw key, so each secret gets its own alert', async () => {
    const s = setup();
    await s.ingest.accept('hermes', rotation('r1', 'prod/db-AbCdEf'));
    await s.ingest.accept('hermes', rotation('r2', 'prod/api-GhIjKl'));
    await s.ingest.accept('hermes', rotation('r3', 'prod/db-AbCdEf'));
    await s.outbox.flush();
    const fired = s.ports.events
      .filter((e) => e.type === 'external.received')
      .map((e) => (e.data as { matchedRules: string[] }).matchedRules.includes('rotation'));
    expect(fired).toEqual([true, true, false]);
  });

  it('redacts the [source] type fallback before createThread cuts it', async () => {
    const s = setup();
    // 120 characters, the longest type the mesh format accepts; the subject cut lands in the token.
    const type = `deploy.${'a'.repeat(72)}.${TOKEN}`;
    await s.ingest.accept('hermes', { id: 'd1', type, severity: 'info', payload: {} });
    const task = s.tasks.get(1, alice);
    for (const text of [task.title, s.subject(task.threadId), s.messaging.thread(1).subject]) {
      expect(text).not.toContain('ghp_');
      expect(text).toContain('[REDACTED]');
    }
  });
});

describe('normalizeEvent for raw sources', () => {
  const source = {
    id: 'ci',
    format: 'raw',
    typeHeader: 'x-event',
    auth: { type: 'bearer', token: 'test-token-0123456789abcdef' },
  } as IngestSource;
  const normalize = (type: string) =>
    normalizeEvent(source, { 'x-event': type }, Buffer.from('{}'));

  it('keeps the type as sent, so rules on it still match', () => {
    // Masked, `token:refresh` became `token:_REDACTED_`: its rule stopped firing.
    expect(normalize('token:refresh')).toMatchObject({
      ok: true,
      event: { type: 'token:refresh' },
    });
  });

  it('refuses a type longer than 120 characters instead of cutting it', () => {
    expect(normalize('a'.repeat(120))).toMatchObject({ ok: true });
    // Cut, a token at the end lost its tail and no longer matched where the type is posted.
    expect(normalize(`deploy.${'a'.repeat(73)}.${TOKEN}`)).toMatchObject({
      ok: false,
      error: 'The event type is longer than 120 characters',
    });
  });
});
