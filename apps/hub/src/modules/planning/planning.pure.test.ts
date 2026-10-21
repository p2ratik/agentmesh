import type { PlanContribution, PlanTaskDraft } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { checkDrafts, topologicalOrder } from './drafts';
import { compileContributions, pickNewFacilitator, roundComplete } from './rounds';

const draft = (key: string, dependsOn: string[] = [], extra: Partial<PlanTaskDraft> = {}) => ({
  key,
  title: `Task ${key}`,
  description: '',
  dependsOn,
  ...extra,
});
const lookups = {
  isAgent: (id: string) => id.endsWith('-agent'),
  isArea: (id: string) => id === 'api',
};

describe('checkDrafts', () => {
  it('orders by dependencies and drops invalid assignees', () => {
    const check = checkDrafts(
      [draft('ui', ['api']), draft('api', [], { assignee: 'nobody' }), draft('docs', ['ui'])],
      lookups,
    );
    expect(check.issues).toEqual([]);
    expect(check.ordered.map((d) => d.key)).toEqual(['api', 'ui', 'docs']);
    expect(check.ordered[0]?.assignee).toBeUndefined();
  });

  it('reports duplicates, unknown keys, self-dependencies, areas and cycles', () => {
    expect(checkDrafts([draft('a'), draft('a')], lookups).issues).toEqual([
      'duplicate task key "a"',
    ]);
    expect(checkDrafts([draft('a', ['zz'])], lookups).issues[0]).toContain('unknown key "zz"');
    expect(checkDrafts([draft('a', ['a'])], lookups).issues).toContain('"a" depends on itself');
    expect(checkDrafts([draft('a', [], { area: 'nope' })], lookups).issues[0]).toContain('area');
    expect(checkDrafts([draft('a', ['b']), draft('b', ['a'])], lookups).issues).toEqual([
      'task dependencies form a cycle',
    ]);
    expect(topologicalOrder([draft('a', ['b']), draft('b', ['a'])])).toBeNull();
  });
});

describe('roundComplete', () => {
  const participants = ['a', 'b', 'c'];
  it('needs everyone or the online quorum', () => {
    const base = { participants, quorum: 1 };
    expect(roundComplete({ ...base, online: new Set(), contributed: new Set() })).toBe(false);
    expect(
      roundComplete({ ...base, online: new Set(['a', 'b']), contributed: new Set(['a']) }),
    ).toBe(false);
    expect(
      roundComplete({ ...base, online: new Set(['a', 'b']), contributed: new Set(['a', 'b']) }),
    ).toBe(true);
    expect(
      roundComplete({ ...base, online: new Set(), contributed: new Set(['a', 'b', 'c']) }),
    ).toBe(true);
    expect(
      roundComplete({
        ...base,
        quorum: 0.5,
        online: new Set(['a', 'b']),
        contributed: new Set(['b']),
      }),
    ).toBe(true);
  });
});

describe('facilitation and compilation', () => {
  const c = (participant: string, round: string, body: string): PlanContribution => ({
    planId: 'plan-1',
    round,
    participant,
    body,
    createdAt: '2026-10-16T09:00:00.000Z',
  });

  it('hands facilitation to the most active online participant', () => {
    const contributions = [c('a', 'r1', 'x'), c('b', 'r1', 'x'), c('b', 'r2', 'y')];
    expect(pickNewFacilitator(['a', 'b', 'c'], 'a', new Set(['b', 'c']), contributions)).toBe('b');
    expect(pickNewFacilitator(['a', 'b'], 'a', new Set(), contributions)).toBeNull();
  });

  it('groups by round and clips when too long', () => {
    const rounds = [
      { id: 'r1', title: 'Proposals', prompt: '', minutes: 1 },
      { id: 'r2', title: 'Discussion', prompt: '', minutes: 1 },
    ];
    const text = compileContributions(rounds, [c('a', 'r1', 'idea'), c('b', 'r2', 'reply')], (id) =>
      id.toUpperCase(),
    );
    expect(text).toMatch(/### Proposals[\s\S]*\*\*A\*\* \(a\):\nidea[\s\S]*### Discussion/);
    const long = compileContributions(rounds, [c('a', 'r1', 'x'.repeat(5000))], (id) => id, 1000);
    expect(long).toContain('truncated');
    expect(compileContributions(rounds, [], (id) => id)).toContain('No contributions');
  });
});
