/** What a masked secret is replaced with. */
export const REDACTED = '[REDACTED]';

/**
 * Credentials recognizable by shape, replaced wholesale. Specific prefixes come
 * before generic ones (e.g. `sk-ant-` before `sk-`).
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // PEM private keys, including a block truncated before its END line.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{32,}/g,
  // Discord bot tokens: base64 user id . timestamp . HMAC.
  /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/g,
  // Anchored on the left: unanchored, a run like `eyJ-eyJ-…` backtracks quadratically.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // NATS nkey seeds (user, account, operator).
  /\bS[UAO][A-Z2-7]{56}\b/g,
];

const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;

/**
 * The key of a `password=…`, `api_key: "…"`, `DB_SECRET=…` or `"token": "…"`
 * assignment. It starts where a run of key characters starts and is bounded on
 * both sides of the keyword; unanchored and unbounded, a long run of key
 * characters (`tokentoken…`) backtracked cubically and stalled the hub.
 */
const KEY_WORD =
  /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,64}?(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]{0,64}/;

/**
 * Group 1: the key up to and past its `=` or `:`, which is kept. Group 2: the
 * value, masked. Calls are marked pure so bundles that never redact (the
 * plugin) drop them.
 */
const assignment = (keyQuote: RegExp, value: RegExp): RegExp =>
  new RegExp(`(${KEY_WORD.source}${keyQuote.source}\\s*[=:]\\s*)(${value.source})`, 'dgi');

/**
 * Two readings of each assignment; the hub masks the union of the values they
 * find. Either reading can swallow an assignment the other one finds, so
 * neither runs alone.
 *
 * The plain reading is the original one: a quoted value runs quote to quote,
 * else the value stops at whitespace, separators and `&` (query strings). It
 * only skips a lone backslash before a quote, which is never a secret.
 */
const PLAIN = /* @__PURE__ */ assignment(/["']?/, /"[^"\n]*"|'[^'\n]*'|(?!\\["'])[^\s,;'"&]+/);

/**
 * The extended reading also covers what the plain one leaves in clear:
 * - a quoted value up to its closing quote, past backslash escapes: stopping
 *   at JSON's `\"` left the rest of a password with a `"` in it in clear.
 *   After a value that ends in `\` (`"C:\dir\" other="x"`), this runs on to
 *   the next quote, swallowing the next key; the plain reading still finds it;
 * - an escaped-quote value or key inside a JSON string
 *   (`{\"password\":\"…\"}`, `DB_PASSWORD=\"…\"`);
 * - an unquoted value that starts at an unclosed (or escaped) quote.
 * The alternatives inside each branch never overlap, so both readings stay
 * linear.
 */
const EXTENDED = /* @__PURE__ */ assignment(
  /(?:\\?["'])?/,
  /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\\"[^"\n]*\\"|\\'[^'\n]*\\'|(?:\\?["'])?[^\s,;'"&]+/,
);

const TYPE_WORDS = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'true',
  'false',
  'unknown',
  'any',
]);

/**
 * Values that are clearly not secrets: env references (`${X}`, `$X`),
 * placeholders (`<your-token>`), member access in code (`req.headers.token`),
 * type annotations (`token: string`), and values already masked.
 */
export function isNonSecretValue(value: string): boolean {
  // An escaped-quote value (`\"…\"`) sheds its escaped quotes, any other value its plain ones.
  const bare = value.startsWith('\\')
    ? value.replace(/^\\["']|\\["']$/g, '')
    : value.replace(/^["']|["']$/g, '');
  if (bare === '' || bare === REDACTED) return true;
  if (/^\$\{?[A-Za-z_]/.test(bare) || bare.startsWith('<')) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(bare)) return true;
  return TYPE_WORDS.has(bare.toLowerCase());
}

/** Keeps the value's quotes: both when it is closed, only the opening one when it is not. */
function maskValue(value: string): string {
  for (const quote of ['\\"', "\\'", '"', "'"]) {
    const closed = value.length >= 2 * quote.length && value.endsWith(quote);
    if (value.startsWith(quote)) return closed ? `${quote}${REDACTED}${quote}` : quote + REDACTED;
  }
  return REDACTED;
}

/** Where `pattern` finds a value that reads as a secret, as [start, end) offsets. */
function secretValues(pattern: RegExp, text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(pattern)) {
    const span = match.indices?.[2];
    if (span && !isNonSecretValue(match[2] ?? '')) spans.push(span);
  }
  return spans;
}

/** Masks the union of the spans: overlapping spans merge, and each merged span is masked once. */
function maskSpans(text: string, spans: Array<[number, number]>): string {
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let done = 0;
  let current: [number, number] | null = null;
  const flush = (span: [number, number]) => {
    out += text.slice(done, span[0]) + maskValue(text.slice(span[0], span[1]));
    done = span[1];
  };
  for (const span of spans) {
    if (current && span[0] < current[1]) current[1] = Math.max(current[1], span[1]);
    else {
      if (current) flush(current);
      current = [span[0], span[1]];
    }
  }
  if (current) flush(current);
  return out + text.slice(done);
}

/**
 * Masking a span can join what is left around it into a new value
 * (`'[REDACTED]x y'`), which a second pass would mask too. So assignments are
 * masked in rounds until nothing changes; each round only masks more.
 */
const MAX_ROUNDS = 4;

/** Masks obvious secrets before a message is stored or published. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(BEARER, `$1${REDACTED}`);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = maskSpans(out, [...secretValues(PLAIN, out), ...secretValues(EXTENDED, out)]);
    if (next === out) break;
    out = next;
  }
  return out;
}
