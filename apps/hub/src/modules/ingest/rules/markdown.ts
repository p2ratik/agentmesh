import { lookup } from './match';
import { maskHead } from './template';

/** `[label]({{path}})`, with the ` · ` after it, or a plain `{{path}}`. */
const TOKEN = /\[([^[\]\n]*)\]\(\{\{\s*([\w.-]+)\s*\}\}\)([ \t]*·[ \t]*)?|\{\{\s*([\w.-]+)\s*\}\}/g;
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
/**
 * What has markdown meaning anywhere in a Discord line: bold, italics, strikes, code and spoilers;
 * masked links; mentions, channels, timestamps and custom emoji (`<`); `@everyone`; and the `:`
 * of a URL Discord would link by itself. Each is shown as written once escaped (`\*`).
 */
const INLINE = /[\\*_~`|[\]<@:]/g;
/** Bidirectional overrides and isolates, which could reorder what a reader sees. */
const BIDI = /[‪-‮⁦-⁩]/g;
const MAX_VALUE = 500;
const MAX_URL = 600;

/**
 * A `format: markdown` notice. The template is the team's own text, so its markdown (bold, lines,
 * masked links) is kept. Every value filled in from the event is masked, cut at 500 characters,
 * put on one line and escaped (`escapeMarkdown`), so external text cannot pass for the template's
 * markdown or open a line of its own.
 *
 * `[label]({{path}})` is a link slot. It becomes a masked link only when the value is an `https`
 * URL on one of `linkHosts` (or a subdomain), wrapped in `<>` so Discord shows no preview.
 * Otherwise the link goes, with the ` · ` after it. One pass: a filled value is never read again,
 * so it cannot add placeholders or links.
 */
export function renderMarkdown(
  template: string,
  context: unknown,
  linkHosts: readonly string[],
): string {
  const value = (path: string) => escapeMarkdown(asText(lookup(context, path)));
  return template
    .replace(TOKEN, (_m, label?: string, link?: string, sep?: string, path?: string) => {
      if (path !== undefined) return value(path);
      const url = safeUrl(lookup(context, link ?? ''), linkHosts);
      if (!url) return '';
      return `[${(label ?? '').replace(PLACEHOLDER, (_p, p: string) => value(p))}](<${url}>)${sep ?? ''}`;
    })
    .replace(/[ \t]*·[ \t]*$/gm, '')
    .trim();
}

/**
 * One line of plain text with no markdown, mention, timestamp or link meaning in Discord. A value
 * may start a line, so a leading heading, quote, subtext, list or numbered-list mark is escaped too.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(BIDI, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(INLINE, '\\$&')
    .replace(/^[#>+-]/, '\\$&')
    .replace(/^(\d+)\./, '$1\\.');
}

/** The URL as Discord should link it, or undefined when it is not https on an allowed host. */
export function safeUrl(value: unknown, hosts: readonly string[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  const allowed = hosts.some((h) => {
    const want = h.toLowerCase();
    return host === want || host.endsWith(`.${want}`);
  });
  if (!allowed || url.href.length > MAX_URL || /[\s<>]/.test(url.href)) return undefined;
  return url.href;
}

/** Masked before it is cut, as everywhere else a value is shown. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? (JSON.stringify(value) ?? '') : String(value);
  return maskHead(text, MAX_VALUE);
}
