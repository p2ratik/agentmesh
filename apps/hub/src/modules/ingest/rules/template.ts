import { redactSecrets } from '@agentmesh/common';
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
  const mask = options.redact === false ? (text: string) => text : redactSecrets;
  return template.replace(PLACEHOLDER, (_match, path: string) =>
    stringify(lookup(context, path), mask),
  );
}

function stringify(value: unknown, mask: (text: string) => string): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return mask(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Masked twice, both before the cut. The strings inside: JSON writes a newline as `\n`, so a
  // token right after one no longer starts at a word boundary. Then the JSON itself, which
  // catches keys and `"api_key":"…"` pairs; it is one value, so it cannot match into the template.
  const json = mask(
    JSON.stringify(value, (_key, item) => (typeof item === 'string' ? mask(item) : item)) ?? '',
  );
  return json.length > MAX_OBJECT_CHARS ? `${json.slice(0, MAX_OBJECT_CHARS)}…` : json;
}
