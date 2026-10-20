import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './redact';

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
