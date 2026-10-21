import { redactSecrets } from '@agentmesh/common';
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

  it('fills strings in raw: whatever shows the text masks it whole', () => {
    // Masked value by value, a BEGIN line alone lost the anchor the key pattern needs downstream.
    const leaked = { ...ctx, summary: `deploy with ${TOKEN}` };
    expect(renderTemplate('CI: {{summary}}', leaked)).toBe(`CI: deploy with ${TOKEN}`);
  });

  it('masks an object before cutting it', () => {
    // The 500-character cut lands 20 characters into the token, too few to match afterwards.
    const payload = { pad: 'a'.repeat(463), log: TOKEN };
    const cut = renderTemplate('{{payload}}', { ...ctx, payload });
    expect(cut).not.toContain('ghp_');
    expect(cut).toContain('"log":"[REDACTED]"');
  });

  it('never shows the end of the masked window, where a token may be cut', () => {
    // Masking the 4.4 KB key shortened the window so much that the 500-character cut fell after
    // the token the window's end cuts in two.
    const key = ['RSA PRIVATE ', 'KEY-----'].join('');
    const pem = `-----BEGIN ${key}${'M'.repeat(4_300)}-----END ${key}`;
    const head = JSON.stringify({ a: pem, b: '' }).length - 2;
    const windowEnd = 500 + 4_096;
    const payload = { a: pem, b: `${'a'.repeat(windowEnd - 21 - head)} ${TOKEN}` };
    // Masked whole, the token is recognised: the leak comes only from the window.
    expect(redactSecrets(JSON.stringify(payload))).not.toContain('ghp_');
    const json = renderTemplate('{{payload}}', { ...ctx, payload });
    expect(json).not.toContain('ghp_');
    expect(json).not.toContain('MMMM');
  });

  it('masks only what it can show of a 1 MB payload', () => {
    // Masked whole, this took 85 ms per placeholder to show 500 characters.
    const payload = { log: 'token=x '.repeat(125_000) };
    const started = performance.now();
    const json = renderTemplate('{{payload}}', { ...ctx, payload });
    expect(performance.now() - started).toBeLessThan(50);
    expect(json.startsWith('{"log":"token=[REDACTED] token=[REDACTED]')).toBe(true);
  });

  it('renders an object raw with redact: false, for throttle keys', () => {
    const payload = { log: TOKEN };
    expect(renderTemplate('{{payload}}', { ...ctx, payload }, { redact: false })).toBe(
      JSON.stringify(payload),
    );
    expect(renderTemplate('{{payload}}', { ...ctx, payload })).toBe('{"log":"[REDACTED]"}');
  });
});
