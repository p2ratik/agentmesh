/** What a masked secret is replaced with. */
export const REDACTED = '[REDACTED]';

/**
 * A key that names a credential. It starts where a run of key characters starts and is bounded on
 * both sides of the keyword; unanchored and unbounded, a long run of key characters (`tokentoken…`)
 * backtracked cubically and stalled the hub on one message.
 */
const KEYWORD = '(?:password|passwd|secret|token|api[_-]?key)';
const KEY = `[A-Za-z0-9_.-]{0,64}?${KEYWORD}[A-Za-z0-9_-]{0,64}`;

/**
 * A credential starts where a word starts, or right after an escaped newline, tab or return in
 * JSON text (`"step failed\nghp_…"`), where `\b` sees no boundary. There it must not be the start
 * of a key being assigned to, whose value the assignment below would no longer find. `word` is
 * what may not come right before it.
 */
const token = (pattern: RegExp, word = '\\w') =>
  new RegExp(String.raw`(?:(?<!${word})|(?<=\\[nrt])(?!${KEY}["']?\s*[=:]))${pattern.source}`, 'g');

/**
 * Credentials recognizable by shape, replaced wholesale. Specific prefixes come
 * before generic ones (e.g. `sk-ant-` before `sk-`).
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // PEM private keys, including a block truncated before its END line.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  token(/(?:AKIA|ASIA)[0-9A-Z]{16}\b/),
  token(/gh[pousr]_[A-Za-z0-9]{36,255}\b/),
  token(/github_pat_[A-Za-z0-9_]{22,255}\b/),
  token(/xox[abprs]-[A-Za-z0-9-]{10,}/),
  token(/sk-ant-[A-Za-z0-9_-]{20,}/),
  token(/sk-[A-Za-z0-9_-]{32,}/),
  // Discord bot tokens: base64 user id . timestamp . HMAC.
  token(/[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/),
  // Anchored on the left: unanchored, a run like `eyJ-eyJ-…` backtracks quadratically.
  token(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, '[A-Za-z0-9_-]'),
  // NATS nkey seeds (user, account, operator).
  token(/S[UAO][A-Z2-7]{56}\b/),
];

/**
 * Only after a word boundary: a bearer token runs across `/` and `+`, so after an escape it could
 * swallow a key further on.
 */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;

/**
 * Some values below take no `=` or `:`, so they never cover a key and value the patterns before
 * task-21 masked. They may still end in base64 padding (`c2VjcmV0=`), but a single `=` right after
 * a key would assign, and its value could run on past this one.
 */
const PADDING = String.raw`(?:==+|(?<!${KEYWORD}[A-Za-z0-9_-]{0,64}["']?\s*)=)?`;
/** Nothing may assign to a value: a key ending where it ends would lose its own value. */
const UNASSIGNED = String.raw`(?!["']?\s*[=:])`;
/** `{\"password\":\"…\"}`: a string in a JSON object written inside a JSON string. */
const ESCAPED_STRING = String.raw`\\"[^"\n=:]*${PADDING}\\"${UNASSIGNED}`;

/**
 * `password=…`, `api_key: "…"`, `DB_SECRET=…`, `"token": "…"`: a quoted string, or a word that
 * stops at whitespace, separators and `&` (query strings).
 */
const VALUE = [
  // A JSON string with an escaped quote in it (`"Xy7\"kP9"`). Past the first escaped quote it
  // takes no `=` or `:`, so it never swallows a key the plain string below leaves to the next match.
  String.raw`"(?:[^"\\\n]|\\[^"\n])*\\"(?:[^"\\\n=:]|\\[^\n=:])*${PADDING}"${UNASSIGNED}`,
  String.raw`"[^"\n]*"`,
  ESCAPED_STRING,
  String.raw`'[^'\n]*'`,
  String.raw`[^\s,;'"&]+`,
].join('|');

/**
 * Keys the patterns before task-21 missed: a key inside a JSON string (`{\"password\":…`), and a
 * name/value entry (`{ name: 'DB_PASSWORD', value: … }`, ECS and Kubernetes environments), whose
 * key runs on to `value`. Whitespace before the comma or line break is spaces and tabs only, so
 * a long run of line breaks is crossed once.
 */
const NEW_KEY = String.raw`${KEY}(?:\\["']|\\?["']?[ \t]*(?:,|\r?\n)\s*(?:\\?["'])?value(?:\\?["'])?)\s*[=:]\s*`;
/** Their values take no `=` or `:` (except base64 padding) and stop where a value stops. */
const NEW_VALUE = [
  String.raw`"(?:[^"\\\n=:]|\\[^\n=:])*${PADDING}"${UNASSIGNED}`,
  String.raw`'[^'\n=:]*${PADDING}'${UNASSIGNED}`,
  ESCAPED_STRING,
  String.raw`[^\s,;'"&=:\\]+${PADDING}(?![^\s,;'"&])${UNASSIGNED}`,
].join('|');

/** Keeps the key, masks the value. */
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(?:(${NEW_KEY})(${NEW_VALUE})|(${KEY}["']?\s*[=:]\s*)(${VALUE}))`,
  'gi',
);

/** Type annotations and plain settings: `token: string`, `token_type: bearer`, `secret_scanning: enabled`. */
const PLAIN_WORDS = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'true',
  'false',
  'unknown',
  'any',
  'none',
  'on',
  'off',
  'yes',
  'no',
  'enabled',
  'disabled',
  'required',
  'optional',
  'bearer',
  'basic',
]);

/**
 * Counts, limits and durations: `max_tokens: 1024`, `token_ttl: 3600`, `128k`. At most 10
 * characters: a digit-only key or session token is longer.
 */
const PLAIN_NUMBER = /^[+-]?\d[\d_.]{0,9}[kmb]?$/i;
/** Keys whose numbers are secrets anyway: passwords and PINs, one-time codes. */
const NUMERIC_SECRET_KEY = /pass(?:word|wd)|otp|mfa/i;
/**
 * A whole env reference, optionally with a path: `$DB_PASSWORD`, `${DB_PASSWORD}`,
 * `${process.env.TOKEN}`, `$env:API_KEY`, `$HOME/.pgpass`. `${PREFIX}hunter2` is not one.
 */
const ENV_REFERENCE = /^\$(?:env:)?\{?[A-Za-z_][\w.]*\}?(?:\/[\w./-]*)?$/;
/** A whole placeholder: `<your-token>`, `<redacted>`. */
const PLACEHOLDER = /^<[^<>=:]*>$/;
/**
 * A whole AWS ARN, `arn:partition:service:region:account:resource`, which names a resource (a
 * secret, a role) but is not a secret. A query string (`?token=…`) is not part of one.
 */
const ARN =
  /^arn:aws[a-z-]*:[a-z0-9-]+:(?:[a-z]{2}(?:-[a-z]+)+-\d)?:(?:\d{12}|aws)?:[\w./:+@*$-]+$/;
/** What follows `secretsmanager:` in a Secrets Manager ARN: region, account, secret name. */
const SECRETS_MANAGER_TAIL = /^[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:secret:[\w./+@-]+$/;

/** The value without the closing brackets of a last JSON member or keyword argument (`true}`, `1024)`). */
function withoutClosers(value: string): string {
  let end = value.length;
  while (end > 0 && ')]}'.includes(value.charAt(end - 1))) end--;
  return value.slice(0, end);
}

/**
 * Values that are clearly not secrets: env references (`${X}`, `$X`),
 * placeholders (`<your-token>`), member access in code (`req.headers.token`),
 * plain words and type annotations, short numbers (except a password, PIN or one-time code),
 * AWS ARNs, and values already masked. Each must be the whole value, so a kept value never hides
 * a key and secret written inside it.
 */
export function isNonSecretValue(value: string, key = ''): boolean {
  // Only a string inside a JSON string starts with `\"`: no other value holds a quote.
  const bare = value.startsWith('\\"') ? value.slice(2, -2) : value.replace(/^["']|["']$/g, '');
  if (bare === '' || bare === REDACTED) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(bare)) return true;
  // The last JSON member or keyword argument brings its closing brackets: `true}`, `1024)`.
  const word = withoutClosers(bare);
  if (ENV_REFERENCE.test(word) || PLACEHOLDER.test(word) || ARN.test(word)) return true;
  // The `secretsmanager:` service part of an ARN in text: `…:secretsmanager:us-east-1:…`.
  if (/^secretsmanager:/i.test(key) && SECRETS_MANAGER_TAIL.test(word)) return true;
  if (PLAIN_NUMBER.test(word)) return !NUMERIC_SECRET_KEY.test(key);
  return PLAIN_WORDS.has(word.toLowerCase());
}

function maskValue(value: string): string {
  const quote = /^\\?["']/.exec(value)?.[0] ?? '';
  return `${quote}${REDACTED}${quote}`;
}

/** Masks obvious secrets before a message is stored or published. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(BEARER, `$1${REDACTED}`);
  return out.replace(ASSIGNMENT, (match, ...groups: (string | undefined)[]) => {
    const [key = '', value = ''] = groups[0] === undefined ? groups.slice(2, 4) : groups;
    return isNonSecretValue(value, key) ? match : `${key}${maskValue(value)}`;
  });
}
