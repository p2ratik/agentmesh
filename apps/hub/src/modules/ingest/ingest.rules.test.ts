import { describe, expect, it } from 'vitest';
import { conditionHolds, lookup, type RuleContext, ruleMatches, typeMatches } from './rules/match';
import { renderTemplate } from './rules/template';

const ctx: RuleContext = {
  id: 'github:1',
  source: 'github',
  type: 'workflow_run.completed',
  severity: 'error',
  summary: 'CI failed',
  url: 'https://github.com/acme/api/actions/runs/1',
  occurredAt: null,
  payload: {
    workflow_run: { conclusion: 'failure', head_branch: 'agents', run_attempt: 2 },
    repository: { full_name: 'acme/api' },
    labels: ['flaky', 'ci'],
  },
};

describe('rule matching', () => {
  it('matches sources, exact and prefix types, and severity floors', () => {
    expect(typeMatches(['workflow_run.*'], ctx.type)).toBe(true);
    expect(typeMatches(['workflow_run'], ctx.type)).toBe(false);
    expect(ruleMatches({ source: ['github'], type: ['workflow_run.*'], where: {} }, ctx)).toBe(
      true,
    );
    expect(ruleMatches({ source: ['posthog'], where: {} }, ctx)).toBe(false);
    expect(ruleMatches({ minSeverity: 'critical', where: {} }, ctx)).toBe(false);
    expect(ruleMatches({ minSeverity: 'warning', where: {} }, ctx)).toBe(true);
  });

  it('evaluates every where-operator on dotted paths', () => {
    const at = (path: string) => lookup(ctx, path);
    expect(conditionHolds(at('payload.workflow_run.conclusion'), { equals: 'failure' })).toBe(true);
    expect(conditionHolds(at('payload.workflow_run.head_branch'), { in: ['main', 'agents'] })).toBe(
      true,
    );
    expect(conditionHolds(at('payload.missing'), { exists: false })).toBe(true);
    expect(conditionHolds(at('payload.labels'), { contains: 'flaky' })).toBe(true);
    expect(conditionHolds(at('summary'), { matches: '^CI (failed|broke)$' })).toBe(true);
    expect(conditionHolds(at('payload.workflow_run.run_attempt'), { gte: 2, lte: 3 })).toBe(true);
    expect(conditionHolds(at('payload.workflow_run.run_attempt'), { gte: 3 })).toBe(false);
    expect(conditionHolds('x', { matches: '(' })).toBe(false);
  });
});

describe('templates', () => {
  it('only looks values up, never evaluates', () => {
    expect(renderTemplate('CI on {{ payload.workflow_run.head_branch }}: {{url}}', ctx)).toBe(
      'CI on agents: https://github.com/acme/api/actions/runs/1',
    );
    expect(renderTemplate('{{ payload.nope }}|{{constructor}}', ctx)).toBe('|');
    expect(renderTemplate('{{payload.labels}}', ctx)).toBe('["flaky","ci"]');
    expect(renderTemplate('{{ process.exit }}', ctx)).toBe('');
  });
});
