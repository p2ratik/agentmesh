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

  // An object is masked before it becomes JSON: JSON writes a newline as `\n`, so in the JSON a
  // token after one no longer starts a word, in a value or in a key.
  it('redacts the strings and the keys inside an object', () => {
    const payload = { log: `step failed\n${TOKEN}`, steps: [{ out: `\t${TOKEN}` }] };
    const json = renderTemplate('{{payload}}', { ...ctx, payload });
    expect(json).toBe('{"log":"step failed\\n[REDACTED]","steps":[{"out":"\\t[REDACTED]"}]}');
    const keyed = { [`note\n${TOKEN}`]: 1, [TOKEN]: 2 };
    expect(renderTemplate('{{payload}}', { ...ctx, payload: keyed })).toBe(
      '{"note\\n[REDACTED]":1,"[REDACTED]":2}',
    );
  });

  it('redacts the whole value under a secret-looking key, unless it reads as a non-secret', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal env reference, kept as is
    const ref = '${API_TOKEN}';
    const env = {
      DB_PASSWORD: 'Xy7"kP9-qL2mZ8wR4tN6',
      auth_token: { id: 7 },
      use_token: true,
      password: null,
      api_token: ref,
    };
    expect(renderTemplate('{{payload}}', { ...ctx, payload: env })).toBe(
      `{"DB_PASSWORD":"[REDACTED]","auth_token":"[REDACTED]","use_token":true,"password":null,"api_token":"${ref}"}`,
    );
  });

  it('tests a value with its JSON quoting, so a leading quote or comma is seen', () => {
    // As `password="Xy7…` and `api_key=,abc…`, the second was not recognised.
    const env = { password: '"Xy7kP9qL2', api_key: ',abc123def' };
    expect(renderTemplate('{{payload}}', { ...ctx, payload: env })).toBe(
      '{"password":"[REDACTED]","api_key":"[REDACTED]"}',
    );
  });

  it('keeps the JSON well-formed, and a non-secret parent intact', () => {
    // Masking the finished JSON swallowed the `}` after a number: {"a":{"max_tokens":[REDACTED],"b":1}
    const payload = { a: { max_tokens: 1024 }, b: 1 };
    const json = renderTemplate('{{payload}}', { ...ctx, payload });
    expect(JSON.parse(json)).toEqual({ a: { max_tokens: '[REDACTED]' }, b: 1 });
    // Testing `repo={"name":"acme","has_token":false}` read `false}` as repo's secret.
    const repo = { repo: { name: 'acme', has_token: false } };
    expect(renderTemplate('{{payload}}', { ...ctx, payload: repo })).toBe(JSON.stringify(repo));
  });

  it('masks only what it shows of a deep or wide payload', () => {
    const timed = (payload: unknown) => {
      const started = performance.now();
      const json = renderTemplate('{{payload}}', { ...ctx, payload });
      return { json, ms: performance.now() - started };
    };
    // Testing each key against its stringified subtree scanned each byte once per ancestor.
    let deep: unknown = {};
    for (let i = 0; i < 900; i++) deep = { s: 'x'.repeat(1_100), c: deep };
    expect(timed(deep).ms).toBeLessThan(100);
    // Masking every key of a wide payload took half a second, to show its first 500 characters.
    const wide = Object.fromEntries(Array.from({ length: 60_000 }, (_, i) => [`key${i}`, 'v']));
    const { json, ms } = timed(wide);
    expect(ms).toBeLessThan(100);
    expect(json.startsWith('{"key0":"v","key1":"v"')).toBe(true);
    expect(json.endsWith('…')).toBe(true);
    // Recursing through every level overflowed the stack, and the rule action was dropped.
    let deeper: unknown = {};
    for (let i = 0; i < 10_000; i++) deeper = [deeper];
    expect(() => renderTemplate('{{payload}}', { ...ctx, payload: deeper })).not.toThrow();
  });

  it('redacts an object before cutting it', () => {
    // The 500-character cut lands 20 characters into the token, too few to match afterwards.
    const payload = { pad: 'a'.repeat(463), log: TOKEN };
    const cut = renderTemplate('{{payload}}', { ...ctx, payload });
    expect(cut).not.toContain('ghp_');
    expect(cut).toContain('"log":"[REDACTED]"');
  });

  it('renders raw with redact: false, for text that is never shown', () => {
    const leaked = { ...ctx, summary: `deploy with ${TOKEN}` };
    expect(renderTemplate('{{summary}}', leaked, { redact: false })).toBe(`deploy with ${TOKEN}`);
  });
});
