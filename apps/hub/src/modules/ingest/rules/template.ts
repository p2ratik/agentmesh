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
  const json = redact ? maskedJson(value, MAX_OBJECT_CHARS) : (JSON.stringify(value) ?? '');
  return json.length > MAX_OBJECT_CHARS ? `${json.slice(0, MAX_OBJECT_CHARS)}…` : json;
}

/**
 * The JSON of a payload value, masked as it is written, so before it is cut:
 * each string and each key on its own, and the whole value under a key that
 * reads as a secret (`password`, `api_key`, `max_tokens`…), whatever its type,
 * unless `redactSecrets` keeps it (`true`, `false`, `null`, `""`, `${VAR}`,
 * `<placeholder>`, dotted names, type words). The finished JSON is not masked:
 * JSON writes a newline as `\n`, which hides a token after it from the patterns,
 * and the unquoted-value pattern would swallow closing braces.
 *
 * Writing stops once past `limit` characters, since nothing after the cut is
 * shown: masking a whole wide payload took half a second per placeholder. Each
 * level writes at least one character, so this also bounds the recursion.
 */
function maskedJson(value: unknown, limit: number): string {
  const parts: string[] = [];
  let length = 0;
  const write = (text: string): void => {
    parts.push(text);
    length += text.length;
  };
  function walk(node: unknown): void {
    if (Array.isArray(node)) writeArray(node);
    else if (node !== null && typeof node === 'object') writeObject(node);
    else write(scalarJson(node));
  }
  function writeArray(items: readonly unknown[]): void {
    write('[');
    for (let i = 0; i < items.length && length <= limit; i++) {
      if (i > 0) write(',');
      walk(items[i]);
    }
    write(']');
  }
  function writeObject(node: object): void {
    write('{');
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length && length <= limit; i++) {
      const key = keys[i] ?? '';
      const maskedKey = redactSecrets(key);
      write(`${i > 0 ? ',' : ''}${JSON.stringify(maskedKey)}:`);
      writeMember(maskedKey, (node as Record<string, unknown>)[key]);
    }
    write('}');
  }
  function writeMember(maskedKey: string, item: unknown): void {
    if (item === null || typeof item !== 'object') {
      const shown = scalarJson(item);
      write(isSecretPair(maskedKey, shown) ? MASKED : shown);
    } else if (isSecretPair(maskedKey, '{')) write(MASKED);
    else walk(item);
  }
  walk(value);
  return parts.join('');
}

const MASKED = JSON.stringify(REDACTED);

/** A string (masked first), number, boolean or null as JSON. */
const scalarJson = (value: unknown): string =>
  JSON.stringify(typeof value === 'string' ? redactSecrets(value) : value) ?? 'null';

/**
 * Whether `key=value` reads as a secret assignment. A scalar is tested as JSON
 * (so a value starting with `"` or `,` is seen whole), after its tokens are
 * masked. An object or array is tested as `{`, before it is written: testing
 * its JSON re-scanned each subtree once per ancestor (seconds on a deep
 * payload) and read a child's `false}` as the parent's secret.
 */
function isSecretPair(key: string, shown: string): boolean {
  const pair = `${key}=${shown}`;
  return redactSecrets(pair) !== pair;
}
