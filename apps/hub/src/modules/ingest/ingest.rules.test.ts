import { describe, expect, it } from 'vitest';
import { conditionHolds, lookup, type RuleContext, ruleMatches, typeMatches } from './rules/match';
import { renderTemplate } from './rules/template';

/** Assembled at runtime so repository secret scanners never flag this file. */
const TOKEN = ['ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('');

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

  it('redacts each value before it is filled in and cut, never the finished text', () => {
    const alarm = {
      ...ctx,
      summary: 'High error rate on api',
      payload: { alarm: 'SecretsManagerRotationFailed' },
    };
    // Masking the finished text matched across template and value ("…Failed: [REDACTED] error").
    expect(renderTemplate('🚨 AWS alarm {{payload.alarm}}: {{summary}}', alarm)).toBe(
      '🚨 AWS alarm SecretsManagerRotationFailed: High error rate on api',
    );
    const leaked = {
      ...ctx,
      summary: `deploy with ${TOKEN}`,
      payload: { log: `${'a'.repeat(479)} ${TOKEN}` },
    };
    const summary = renderTemplate('CI: {{summary}}', leaked);
    expect(summary).toBe('CI: deploy with [REDACTED]');
    // An object renders as JSON cut at 500 characters: 12 characters into the raw token.
    const json = renderTemplate('{{payload}}', leaked);
    expect(json).not.toContain('ghp_');
    expect(json).toContain('[REDACTED]');
  });

  it('redacts the strings inside an object, not only its JSON', () => {
    // JSON writes the newline as `\n`, so in the JSON the token no longer starts a word.
    const payload = { log: `step failed\n${TOKEN}`, steps: [{ out: `\t${TOKEN}` }] };
    const json = renderTemplate('{{payload}}', { ...ctx, payload });
    expect(json).toBe('{"log":"step failed\\n[REDACTED]","steps":[{"out":"\\t[REDACTED]"}]}');
  });

  it('redacts the JSON of an object too: its keys and its key/value pairs', () => {
    const env = { DB_PASSWORD: 'hunter2-prod-x9', [TOKEN]: 1 };
    expect(renderTemplate('{{payload}}', { ...ctx, payload: env })).toBe(
      '{"DB_PASSWORD":"[REDACTED]","[REDACTED]":1}',
    );
    // The 500-character cut lands five characters into the value. Masking after the cut would
    // miss it: an unterminated quoted value does not match.
    const payload = { pad: 'a'.repeat(474), api_key: 'abc123def456ghi789' };
    const cut = renderTemplate('{{payload}}', { ...ctx, payload });
    expect(cut).not.toContain('abc12');
    expect(cut).toContain('"api_key":"[REDA');
  });

  it('renders raw with redact: false, for text that is never shown', () => {
    const leaked = { ...ctx, summary: `deploy with ${TOKEN}` };
    expect(renderTemplate('{{summary}}', leaked, { redact: false })).toBe(`deploy with ${TOKEN}`);
  });
});
