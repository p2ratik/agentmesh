import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './redact';

/**
 * Fake credentials, assembled at runtime so repository secret scanners never
 * mistake this test file for a leak.
 */
const fake = (...parts: string[]) => parts.join('');
const AWS = fake('AKIA', 'ABCDEFGHIJKLMNOP');
const GITHUB = fake('ghp', '_', '0123456789abcdefghijklmnopqrstuvwxyzAB');
const SLACK = fake('xox', 'b-', '1234567890-abcdefghij');
const ANTHROPIC = fake('sk-', 'ant-api03-', 'abcdefghijklmnopqrstuvwxyz');

describe('redactSecrets', () => {
  it('masks common credential formats but keeps the surrounding text', () => {
    const text = [
      `aws ${AWS} here`,
      `token ${GITHUB}`,
      `slack ${SLACK}`,
      `key ${ANTHROPIC}`,
      'password = "hunter2hunter2"',
      fake('-----BEGIN RSA PRIVATE ', 'KEY-----\nMIIabc\n-----END RSA PRIVATE ', 'KEY-----'),
    ].join('\n');
    const out = redactSecrets(text);
    for (const secret of [AWS, GITHUB, SLACK, ANTHROPIC, 'hunter2', 'MIIabc']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('aws');
    expect(out).toContain('password');
    expect(out.split(REDACTED).length - 1).toBeGreaterThanOrEqual(6);
  });

  it('leaves ordinary engineering text alone', () => {
    const text =
      'Set retries=3 and token_count limit; see task-42 and https://github.com/acme/api/pull/7';
    expect(redactSecrets(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactSecrets(`deploy with ${GITHUB} and api_key=abcdef123456`);
    expect(redactSecrets(once)).toBe(once);
  });
});

/** Milliseconds one call takes. */
function timed(text: string): number {
  const start = performance.now();
  redactSecrets(text);
  return performance.now() - start;
}

// A message body may be 32 KB, and rule notices carry external text: no input may make the
// patterns backtrack. These ran for seconds to minutes when the key and JWT were unanchored.
describe('redactSecrets on hostile input', () => {
  it.each([
    ['keywords back to back', 'token'.repeat(6_400)],
    ['one long word', 'a'.repeat(32_000)],
    ['key characters without a value', 'db.password_'.repeat(2_600)],
    ['JWT-like runs', 'eyJ-'.repeat(8_000)],
  ])('stays linear on %s', (_label, text) => {
    expect(timed(text)).toBeLessThan(250);
  });

  it('still masks a secret after a long run of key characters', () => {
    expect(redactSecrets(`${'x'.repeat(5_000)} api_key=abc123def456`)).toContain(
      `api_key=${REDACTED}`,
    );
  });
});
