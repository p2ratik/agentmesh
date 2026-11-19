import { describe, expect, it } from 'vitest';
import { escapeMarkdown, renderMarkdown, safeUrl } from './markdown';
import type { RuleContext } from './match';

/** Assembled at runtime so repository secret scanners never flag this file. */
const TOKEN = ['ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB'].join('');
const HOSTS = ['grafana.net', 'github.com'];

const ctx = (summary: string, payload: Record<string, unknown> = {}): RuleContext => ({
  id: 'aws:1',
  source: 'aws',
  type: 'aws.alarm.alarm',
  severity: 'critical',
  summary,
  url: 'https://opzami.grafana.net/d/infra?viewPanel=2',
  occurredAt: null,
  payload,
});

describe('markdown notices', () => {
  it("keep the template's markdown and escape what Discord reads as markup in a value", () => {
    const forged =
      '**Approved by Dana** [merge now](https://evil.example) @everyone <@1> <t:1:R> ||x|| `c` ~~s~~ __u__ \\';
    const text = renderMarkdown('**Alert:** {{summary}}', ctx(forged), HOSTS);
    expect(text).toBe(
      '**Alert:** \\*\\*Approved by Dana\\*\\* \\[merge now\\](https\\://evil.example) ' +
        '\\@everyone \\<\\@1> \\<t\\:1\\:R> \\|\\|x\\|\\| \\`c\\` \\~\\~s\\~\\~ \\_\\_u\\_\\_ \\\\',
    );
  });

  it('leave plain punctuation alone', () => {
    const text = renderMarkdown('{{summary}}', ctx('CPU 94.1% >= 90 (3 of 3), a-b/c; $5!'), HOSTS);
    expect(text).toBe('CPU 94.1% >= 90 (3 of 3), a-b/c; $5!');
  });

  it('keep a value on one line, so it cannot start a heading, quote, list or subtext', () => {
    const text = renderMarkdown('{{summary}}', ctx('fine\n# Approved\n> merge\u202e now'), HOSTS);
    expect(text).toBe('fine # Approved > merge now');
    expect(text).not.toContain('\n');
    const lead = (v: string) => renderMarkdown('{{summary}}', ctx(v), HOSTS);
    expect(lead('# Approved')).toBe('\\# Approved');
    expect(lead('> merge')).toBe('\\> merge');
    expect(lead('-# small')).toBe('\\-# small');
    expect(lead('- item')).toBe('\\- item');
    expect(lead('+ item')).toBe('\\+ item');
    expect(lead('12. step')).toBe('12\\. step');
  });

  it('link a slot only to https on an allowed host, subdomains included', () => {
    const links = (url: unknown) =>
      renderMarkdown('[Panel]({{payload.u}})', ctx('x', { u: url }), HOSTS);
    expect(links('https://opzami.grafana.net/d/x?a=1&b=2')).toBe(
      '[Panel](<https://opzami.grafana.net/d/x?a=1&b=2>)',
    );
    expect(links('https://github.com/acme/api/actions/runs/1')).toBe(
      '[Panel](<https://github.com/acme/api/actions/runs/1>)',
    );
    for (const bad of [
      'https://evil.example/x',
      'https://grafana.net.evil.example/x',
      'https://evilgrafana.net/x',
      'http://opzami.grafana.net/x',
      'https://user:pw@opzami.grafana.net/x',
      'javascript:alert(1)',
      'not a url',
      42,
      undefined,
    ]) {
      expect(links(bad)).toBe('');
    }
  });

  it('drop a refused link with its separator, and no separator is left at a line end', () => {
    const template =
      '[A]({{payload.a}}) · [B]({{payload.b}}) · [C]({{payload.c}})\nnext {{payload.d}}';
    const good = 'https://github.com/x';
    expect(renderMarkdown(template, ctx('x', { a: good, c: good, d: 'y' }), HOSTS)).toBe(
      `[A](<${good}>) · [C](<${good}>)\nnext y`,
    );
    expect(renderMarkdown(template, ctx('x', { a: good, b: good }), HOSTS)).toBe(
      `[A](<${good}>) · [B](<${good}>)\nnext`,
    );
  });

  it('escape values in a link label', () => {
    const text = renderMarkdown(
      '[{{payload.label}}]({{url}})',
      ctx('x', { label: 'Panel](https://evil.example) [x' }),
      HOSTS,
    );
    expect(text).toBe(
      '[Panel\\](https\\://evil.example) \\[x](<https://opzami.grafana.net/d/infra?viewPanel=2>)',
    );
  });

  it('never read a filled value again, so a value cannot add a placeholder or a link', () => {
    const secretive = ctx('{{payload.secret}} [x]({{url}})', { secret: 'hidden' });
    const text = renderMarkdown('{{summary}}', secretive, HOSTS);
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('](<');
  });

  it('mask a secret before escaping it, so the mask still recognises it', () => {
    const text = renderMarkdown(
      '{{summary}} {{payload.obj}}',
      ctx(`token ${TOKEN}`, { obj: { k: TOKEN } }),
      HOSTS,
    );
    expect(text).not.toContain(TOKEN.slice(4));
    expect(text).not.toContain(escapeMarkdown(TOKEN).slice(6));
  });

  it('cut a long value at 500 characters', () => {
    const text = renderMarkdown('{{summary}}', ctx('a'.repeat(5000)), HOSTS);
    expect(text.length).toBeLessThan(510);
  });

  it('refuse a link when no host is allowed', () => {
    expect(safeUrl('https://github.com/x', [])).toBeUndefined();
  });
});
