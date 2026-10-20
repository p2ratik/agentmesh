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
 * `SecretsManager…` would lose the summary's first word.
 */
export function renderTemplate(template: string, context: unknown): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => stringify(lookup(context, path)));
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = redactSecrets(JSON.stringify(value) ?? '');
  return json.length > MAX_OBJECT_CHARS ? `${json.slice(0, MAX_OBJECT_CHARS)}…` : json;
}
