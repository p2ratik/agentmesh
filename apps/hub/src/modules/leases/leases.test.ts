import { HOUR_MS } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '../../testing/harness';
import { LeaseServiceImpl } from './leases.service';
import { literalPrefix, pathsOverlap, reposOverlap } from './overlap';

describe('path overlap', () => {
  it('compares literal prefixes conservatively', () => {
    expect(literalPrefix('./api/**/*.ts')).toBe('api/');
    expect(literalPrefix('api\\types\\index.ts')).toBe('api/types/index.ts');
    expect(pathsOverlap('api/**', 'api/types/**')).toBe(true);
    expect(pathsOverlap('api/**', 'api/index.ts')).toBe(true);
    expect(pathsOverlap('api/**', 'web/**')).toBe(false);
    expect(pathsOverlap('**', 'anything')).toBe(true);
  });

  it('treats a missing repo as every repo', () => {
    expect(reposOverlap(null, 'acme/api')).toBe(true);
    expect(reposOverlap('Acme/API', 'acme/api')).toBe(true);
    expect(reposOverlap('acme/api', 'acme/web')).toBe(false);
  });
});

describe('LeaseServiceImpl', () => {
  const request = (holder: string, paths: string[], repo: string | null = 'acme/api') => ({
    holder,
    paths,
    repo,
    ttlMinutes: null,
    reason: null,
    taskId: null,
  });

  it('grants, reports conflicts all-or-nothing, and extends own leases', () => {
    const { ctx, clock } = createTestHarness();
    const leases = new LeaseServiceImpl(ctx);
    expect(leases.acquire(request('alice-agent', ['api/types/**'])).granted).toHaveLength(1);

    const blocked = leases.acquire(request('bob-agent', ['web/**', 'api/**']));
    expect(blocked.granted).toEqual([]);
    expect(blocked.conflicts).toEqual([
      expect.objectContaining({ requested: 'api/**', held: 'api/types/**', holder: 'alice-agent' }),
    ]);
    expect(leases.list({ holder: 'bob-agent' })).toEqual([]);

    clock.advance(HOUR_MS);
    const extended = leases.acquire(request('alice-agent', ['api/types/**']));
    expect(extended.granted).toHaveLength(1);
    expect(leases.list({})).toHaveLength(1);
    expect(leases.acquire(request('bob-agent', ['api/**'], 'acme/web')).granted).toHaveLength(1);
  });

  it('expires, releases by path, by task and all', () => {
    const { ctx, clock } = createTestHarness();
    const leases = new LeaseServiceImpl(ctx);
    leases.acquire({ ...request('alice-agent', ['a/**', 'b/**']), taskId: 7 });
    leases.acquire(request('alice-agent', ['c/**']));
    expect(leases.release('alice-agent', ['./a/**'])).toBe(1);
    expect(leases.releaseForTask(7)).toBe(1);
    clock.advance(3 * HOUR_MS);
    expect(leases.list({})).toEqual([]);
    expect(leases.acquire(request('bob-agent', ['c/**'])).granted).toHaveLength(1);
    expect(leases.releaseAll('bob-agent')).toBe(1);
  });
});
