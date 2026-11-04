import { describe, expect, it } from 'vitest';
import { checkHealth, type HealthProbes } from './health';

const healthy = (): HealthProbes => ({
  started: () => true,
  db: () => undefined,
  natsRoundTrip: () => Promise.resolve(3),
  subscriptionsOpen: () => true,
});

describe('checkHealth', () => {
  it('is ok when every part answers', async () => {
    expect(await checkHealth(healthy())).toEqual({
      ok: true,
      checks: { started: true, db: true, nats: true, subscriptions: true },
    });
  });

  it('counts a hub without NATS as reachable', async () => {
    const report = await checkHealth({ ...healthy(), natsRoundTrip: () => null });
    expect(report.ok).toBe(true);
  });

  it.each([
    ['started', { started: () => false }],
    [
      'db',
      {
        db: () => {
          throw new Error('database is locked');
        },
      },
    ],
    ['nats', { natsRoundTrip: () => Promise.reject(new Error('CONNECTION_CLOSED')) }],
    [
      'nats',
      {
        natsRoundTrip: () => {
          throw new Error('closed');
        },
      },
    ],
    ['subscriptions', { subscriptionsOpen: () => false }],
  ] as const)('fails %s and names only that check', async (name, broken) => {
    const report = await checkHealth({ ...healthy(), ...broken });
    expect(report.ok).toBe(false);
    expect(Object.entries(report.checks).filter(([, ok]) => !ok)).toEqual([[name, false]]);
  });

  it('gives up on a NATS round trip that never completes', async () => {
    const report = await checkHealth(
      { ...healthy(), natsRoundTrip: () => new Promise(() => {}) },
      20,
    );
    expect(report.checks.nats).toBe(false);
  });

  it('never carries an error text', async () => {
    const report = await checkHealth({
      ...healthy(),
      db: () => {
        throw new Error('secret=hunter2');
      },
    });
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });
});
