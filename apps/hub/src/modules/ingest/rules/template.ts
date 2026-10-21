import { redactSecrets } from '@agentmesh/common';
import { lookup } from './match';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
const MAX_OBJECT_CHARS = 500;
/** How far past the cut an object's JSON is masked, so a token that straddles the cut is seen whole. */
const MASK_MARGIN = 4096;

/**
 * Fills `{{ path }}` placeholders from the rule context. Lookups only — no
 * expressions, so a template can never execute anything. Missing values
 * render as empty strings; objects render as (truncated) JSON.
 *
 * Values are filled in raw: whatever shows the text masks it whole (`post()`
 * the body, the rule action the subject and title, the bridge every post).
 * Only an object is cut here, so its JSON is masked before the cut, unless
 * `redact: false`: throttle keys are never shown, and masked they would merge
 * (every secret's ARN would share one).
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
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = JSON.stringify(value) ?? '';
  return redact ? maskHead(json, MAX_OBJECT_CHARS) : cut(json, MAX_OBJECT_CHARS);
}

/**
 * Masks `text` and cuts it at `limit`, masking only what can be shown: the
 * first 4 KB past the cut, one linear pass whatever the text's size (up to
 * 1 MB). Past that window a token may be cut in two, unrecognised, so when the
 * text runs on, the last 4 KB of the masked window are never shown: masking
 * shortens the text, and a fixed cut could then reach the window's end.
 */
export function maskHead(text: string, limit: number): string {
  const window = text.slice(0, limit + MASK_MARGIN);
  const masked = redactSecrets(window);
  if (window.length === text.length) return cut(masked, limit);
  const end = Math.max(0, Math.min(limit, masked.length - MASK_MARGIN));
  return `${masked.slice(0, end)}…`;
}

const cut = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;
