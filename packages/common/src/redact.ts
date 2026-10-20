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
 * `password=…`, `api_key: "…"`, `DB_SECRET=…`, `"token": "…"`: keeps the key,
 * masks the value. Values stop at whitespace, separators and `&` (query strings).
 * The key starts where a run of key characters starts and is bounded on both
 * sides of the keyword; unanchored and unbounded, a long run of key characters
 * (`tokentoken…`) backtracked cubically and stalled the hub on one message.
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}?(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]{0,64}["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;'"&]+)/gi;

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
  const bare = value.replace(/^["']|["']$/g, '');
  if (bare === '' || bare === REDACTED) return true;
  if (/^\$\{?[A-Za-z_]/.test(bare) || bare.startsWith('<')) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(bare)) return true;
  return TYPE_WORDS.has(bare.toLowerCase());
}

function maskValue(value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  return `${quote}${REDACTED}${quote}`;
}

/** Masks obvious secrets before a message is stored or published. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(BEARER, `$1${REDACTED}`);
  return out.replace(ASSIGNMENT, (match, key: string, value: string) =>
    isNonSecretValue(value) ? match : `${key}${maskValue(value)}`,
  );
}
