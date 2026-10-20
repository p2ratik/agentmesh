import { REDACTED, redactSecrets } from '@agentmesh/common';
import { lookup } from './match';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
const MAX_OBJECT_CHARS = 500;

/**
 * Fills `{{ path }}` placeholders from the rule context. Lookups only — no
 * expressions, so a template can never execute anything. Missing values
 * render as empty strings; objects render as (truncated) JSON.
 *
 * Each value is redacted before it is filled in (and before it is cut); the
 * template text is trusted config. Masking the finished text instead would
 * match across the two: `{{alarm}}: {{summary}}` with an alarm named
 * `SecretsManager…` would lose the summary's first word. `redact: false` is
 * for text that is never shown, such as throttle keys: masking would merge
 * keys (every secret's ARN would share one).
 */
export function renderTemplate(
  template: string,
  context: unknown,
  options: { redact?: boolean } = {},
): string {
  const redact = options.redact !== false;
  return template.replace(PLACEHOLDER, (_match, path: string) =>
    stringify(lookup(context, path), redact),
  );
}

function stringify(value: unknown, redact: boolean): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return redact ? redactSecrets(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = JSON.stringify(redact ? maskTree(value) : value) ?? '';
  return json.length > MAX_OBJECT_CHARS ? `${json.slice(0, MAX_OBJECT_CHARS)}…` : json;
}

/**
 * A copy of a JSON value with its secrets masked before it becomes JSON (and is
 * cut): each string and each key on its own, and the whole value under a key
 * that reads as a secret (`password`, `api_key`, `max_tokens`…), whatever its
 * type. The finished JSON is not masked: JSON writes a newline as `\n`, which
 * hides a token after it from the patterns, and the unquoted-value pattern
 * would swallow closing braces.
 */
function maskTree(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(maskTree);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const masked = maskTree(item);
      const maskedKey = redactSecrets(key);
      return [maskedKey, isSecretPair(maskedKey, masked) ? REDACTED : masked];
    }),
  );
}

/** Whether `key=value` reads as a secret assignment, once the tokens inside it are masked. */
function isSecretPair(key: string, value: unknown): boolean {
  const pair = `${key}=${JSON.stringify(value) ?? ''}`;
  return redactSecrets(pair) !== pair;
}
