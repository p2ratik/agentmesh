import { REDACTED, redactSecrets } from '@agentmesh/common';
import { lookup } from './match';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
const MAX_OBJECT_CHARS = 500;
const MAX_DEPTH = 1000;
const TOO_DEEP = '[object too deep]';

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
 * type, except `true`, `false` and `null`, which are kept. The finished JSON is
 * not masked: JSON writes a newline as `\n`, which hides a token after it from
 * the patterns, and the unquoted-value pattern would swallow closing braces.
 * Below `MAX_DEPTH` levels a subtree becomes `TOO_DEEP`: recursing further would
 * overflow the stack, and the rule action would be dropped.
 */
function maskTree(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) return value.map((item) => maskTree(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const masked = maskTree(item, depth + 1);
      const maskedKey = redactSecrets(key);
      return [maskedKey, isSecretPair(maskedKey, masked) ? REDACTED : masked];
    }),
  );
}

/**
 * Whether `key=value` reads as a secret assignment. A scalar is tested as JSON
 * (so a value starting with `"` or `,` is seen whole), after its tokens are
 * masked. An object or array is tested as `{`: its children are masked already,
 * and stringifying them re-scanned each subtree once per ancestor (seconds on a
 * deep payload) and read a child's `false}` as the parent's secret.
 */
function isSecretPair(key: string, value: unknown): boolean {
  const shown = value !== null && typeof value === 'object' ? '{' : JSON.stringify(value);
  const pair = `${key}=${shown ?? ''}`;
  return redactSecrets(pair) !== pair;
}
