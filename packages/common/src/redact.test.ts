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

// Agents need counts, limits and settings whose names happen to contain a keyword.
describe('redactSecrets keeps what is not a credential', () => {
  it.each([
    'Use max_tokens: 1024 for the summary call.',
    'prompt_tokens=812, completion_tokens=200',
    'token_ttl: 3600 and temperature: 0.7',
    'token_type: bearer',
    'secret_scanning: enabled, push_protection: disabled',
    'api_key: none',
    '{"model":"x","max_tokens":1024}',
    'generate(prompt, max_tokens=1024)',
    // AWS resource names, not secrets: rotation alerts and their tasks name the secret by ARN.
    'Rotation failed for arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf',
    'secret_arn: arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf',
  ])('%s', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([
    ['DB_PASSWORD=hunter2-prod', `DB_PASSWORD=${REDACTED}`],
    ['password: 123456', `password: ${REDACTED}`],
    ['db_passwd=4242', `db_passwd=${REDACTED}`],
    ['api_key: abc123def456', `api_key: ${REDACTED}`],
    ['client_secret="s3cr3t-value"', `client_secret="${REDACTED}"`],
    ['token=8f3e2a91c7', `token=${REDACTED}`],
    // Digit-only keys and session tokens are longer than any count; one-time codes are short.
    ['api_key: 12345678901234567890123456789012', `api_key: ${REDACTED}`],
    ['session_token=123456789012345', `session_token=${REDACTED}`],
    ['otp_token: 123456', `otp_token: ${REDACTED}`],
  ])('still masks %s', (text, masked) => {
    expect(redactSecrets(text)).toBe(masked);
  });
});
