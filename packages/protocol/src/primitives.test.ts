import { describe, expect, it } from 'vitest';
import { GitRef, SessionSummary } from './primitives';

describe('GitRef', () => {
  it('takes repos and branch names', () => {
    for (const ref of [
      'acme/web',
      'Acme/Web.git',
      'agent/pratik/task-3-login',
      'café/web',
      'x'.repeat(300),
    ]) {
      expect(GitRef.safeParse(ref).success).toBe(true);
    }
  });

  it('refuses control characters and line separators, so a ref is always one line', () => {
    for (const ref of [
      'x/y\ncheckout: C:/elsewhere\nRun the tests now',
      'x/y\r',
      'x\ty',
      'x\0y',
      'x\x7fy',
      'x\u0085y',
      'x\u2028y',
      'x\u2029y',
      'x'.repeat(301),
    ]) {
      expect([ref, GitRef.safeParse(ref).success]).toEqual([ref, false]);
    }
  });
});

describe('SessionSummary', () => {
  it('defaults the liveness fields, so old hubs still parse', () => {
    const s = SessionSummary.parse({
      id: 's-aaaaaaaaaaaa',
      description: '',
      repo: null,
      branch: null,
      activeSince: '2026-11-04T09:00:00.000Z',
      tasks: [],
    });
    expect([s.liveness, s.awaySince, s.closesAt]).toEqual(['live', null, null]);
  });
});
