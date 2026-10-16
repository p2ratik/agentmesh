import { lookup } from './match';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
const MAX_OBJECT_CHARS = 500;

/**
 * Fills `{{ path }}` placeholders from the rule context. Lookups only — no
 * expressions, so a template can never execute anything. Missing values
 * render as empty strings; objects render as (truncated) JSON.
 */
export function renderTemplate(template: string, context: unknown): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => stringify(lookup(context, path)));
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = JSON.stringify(value) ?? '';
  return json.length > MAX_OBJECT_CHARS ? `${json.slice(0, MAX_OBJECT_CHARS)}…` : json;
}
