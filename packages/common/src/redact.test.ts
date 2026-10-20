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

  it('masks a whole quoted value, past escaped quotes inside it', () => {
    // Stopping at JSON's `\"` left the rest of the password in clear after `[REDACTED]`.
    expect(redactSecrets('{"DB_PASSWORD":"Xy7\\"kP9-qL2mZ8wR4tN6","b":1}')).toBe(
      '{"DB_PASSWORD":"[REDACTED]","b":1}',
    );
    expect(redactSecrets("password='ab\\'cd-tail' next")).toBe("password='[REDACTED]' next");
    expect(redactSecrets('token="a\\\\" rest')).toBe('token="[REDACTED]" rest');
  });

  it('masks a quoted value that ends in a backslash, and an unclosed one', () => {
    // Read as an escape, `\"` never closed the value, and nothing else could match it.
    expect(redactSecrets('password="hunter2\\" next')).toBe('password="[REDACTED]" next');
    expect(redactSecrets('password="hunter2\\\\\\" next')).toBe('password="[REDACTED]" next');
    expect(redactSecrets("$env:DB_PASSWORD='Abc123\\' ;")).toBe("$env:DB_PASSWORD='[REDACTED]' ;");
    // Several words: only the plain quote-to-quote reading sees the whole value.
    expect(redactSecrets('password="correct horse\\" next')).toBe('password="[REDACTED]" next');
    expect(redactSecrets("password='correct horse\\' next")).toBe("password='[REDACTED]' next");
  });

  it('masks only the first word of an unclosed quoted value', () => {
    expect(redactSecrets('password="hunter2 more')).toBe('password="[REDACTED] more');
  });

  it('masks escaped-quote values and keys inside a JSON string', () => {
    expect(redactSecrets('{"message":"DB_PASSWORD=\\"hunter2-prod\\" failed"}')).toBe(
      '{"message":"DB_PASSWORD=\\"[REDACTED]\\" failed"}',
    );
    expect(redactSecrets('{"message":"DB_PASSWORD=\\"hunter2X9')).toBe(
      '{"message":"DB_PASSWORD=\\"[REDACTED]',
    );
    expect(redactSecrets('{"body":"{\\"password\\":\\"hunter2\\"}"}')).toBe(
      '{"body":"{\\"password\\":\\"[REDACTED]\\"}"}',
    );
    // Without its escaped quotes, the value is an env reference.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal env reference, kept as is
    const ref = 'API_TOKEN=\\"${API_TOKEN}\\"';
    expect(redactSecrets(ref)).toBe(ref);
    // Escaped single quotes, as in a JavaScript string literal, are kept too.
    expect(redactSecrets("const s = 'password=\\'hunter2\\''")).toBe(
      "const s = 'password=\\'[REDACTED]\\''",
    );
    expect(redactSecrets("password=\\'hunter2 x")).toBe("password=\\'[REDACTED] x");
  });

  it('stays idempotent on every quoting it masks', () => {
    for (const text of [
      'password="hunter2\\" next',
      'password="hunter2',
      '{"m":"DB_PASSWORD=\\"hunter2-prod\\" failed"}',
      // The last branch masked only the backslash, freeing the quote for a second pass.
      'token="\\" password=\\"hunter2X9 x',
    ]) {
      const once = redactSecrets(text);
      expect(once).not.toContain('hunter2');
      expect(redactSecrets(once)).toBe(once);
    }
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
    ['an unclosed quoted value of escapes', `token="${'\\"'.repeat(16_000)}`],
    ['keys inside an unclosed quoted value', `token="${'\\"token="'.repeat(3_500)}`],
    ['both quotes, unclosed', `token='${`"token=\\'`.repeat(3_500)}`],
    ['values ending in a backslash', 'password="x\\" '.repeat(2_200)],
    ['an unclosed escaped-quote value', `token=\\"${'a'.repeat(32_000)}`],
    ['escaped-quote values back to back', 'token=\\"x'.repeat(3_500)],
    ['Windows paths before keys', '--token-dir="C:\\k\\" --password="x" '.repeat(900)],
    ['JSON keys inside JSON strings', '{\\"password\\":\\"x\\"} '.repeat(1_500)],
    ['env references swallowing keys', 'TOKEN="$H\\" PASSWORD="x" '.repeat(1_300)],
  ])('stays linear on %s', (_label, text) => {
    expect(timed(text)).toBeLessThan(250);
  });

  it('masks an unclosed escaped-quote value', () => {
    expect(redactSecrets(`token=\\"${'a'.repeat(32_000)}`)).toBe('token=\\"[REDACTED]');
  });

  it('still masks a secret after a long run of key characters', () => {
    expect(redactSecrets(`${'x'.repeat(5_000)} api_key=abc123def456`)).toContain(
      `api_key=${REDACTED}`,
    );
  });
});
