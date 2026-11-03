import { describe, expect, it } from 'vitest';
import { GitRef } from './primitives';

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
