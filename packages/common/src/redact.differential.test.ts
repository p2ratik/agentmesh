import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact';
import { redactSecrets as baseline } from './testing/redact-baseline';

/**
 * The redactor may keep more of what is not a credential (`"secret_scanning":true}`), but it must
 * never show a secret that the redactor before task-21 masked (`testing/redact-baseline.ts`).
 * Every input below carries one planted secret; the check is that whatever the baseline hid stays
 * hidden, and that masking twice changes nothing.
 */

/** mulberry32: a small seeded generator, so every run checks the same inputs. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seeded(21);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const chars = (alphabet: string, length: number) =>
  Array.from({ length }, () => pick([...alphabet])).join('');

/**
 * Letters and digits taking turns, so no window of a secret spells a word, a count or anything
 * else the inputs contain (their only long number is the account `000000000000`).
 */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const run = (length: number) =>
  Array.from({ length }, (_, i) => pick([...(i % 2 ? '23456789' : LETTERS)])).join('');
const upper = (length: number) =>
  Array.from({ length }, (_, i) => pick([...(i % 2 ? '234567' : 'ABCDEFGHJKLMNPQRSTUVWXYZ')])).join(
    '',
  );

/** Credentials by shape, assembled at runtime so repository secret scanners never flag this file. */
const TOKENS: ReadonlyArray<() => string> = [
  () => ['gh', 'p_', run(36)].join(''),
  () => ['github_', 'pat_', run(30)].join(''),
  () => ['AK', 'IA', upper(16)].join(''),
  () => ['xo', 'xb-', run(10), '-', run(12)].join(''),
  () => ['sk-', 'ant-api03-', run(24)].join(''),
  () => ['sk-', run(40)].join(''),
  () => ['ey', 'J', run(12), '.', run(12), '.', run(12)].join(''),
  () => ['S', 'U', upper(56)].join(''),
];

/** Secrets a key names: plain, with the characters that end or escape a value, digit-only. */
const SECRETS: ReadonlyArray<() => string> = [
  () => run(14),
  () => `${run(8)}-${run(8)}_${run(6)}`,
  () => `${run(8)}"${run(8)}`,
  () => `${run(8)}\\${run(8)}`,
  () => `${run(8)}'${run(8)}`,
  () => `${run(8)}=${run(8)}==`,
  () => `${run(8)}:${run(8)}`,
  () => `${run(8)}}${run(8)}`,
  () => `${run(12)})`,
  () => `${run(8)} ${run(8)}`,
  () => `${run(8)}!@#%${run(8)}`,
  () => `${run(8)}/${run(8)}+${run(8)}`,
  () => chars('23456789', 16),
  () => chars('23456789', 6),
  () => pick(TOKENS)(),
];

const KEYS = [
  'password',
  'DB_PASSWORD',
  'db.password',
  'passwd',
  'client_secret',
  'SECRET',
  'api_key',
  'apiKey',
  'x-api-key',
  'token',
  'GITHUB_TOKEN',
  'session_token',
  'otp_token',
  'mfa_secret',
];

/** The ways configs, logs, URLs and JSON (also JSON inside JSON) write a key and its value. */
const WRITINGS: ReadonlyArray<(key: string, value: string) => string> = [
  (k, v) => `${k}=${v}`,
  (k, v) => `export ${k}=${v}`,
  (k, v) => `${k}: ${v}`,
  (k, v) => `${k} = "${v}"`,
  (k, v) => `${k}='${v}'`,
  (k, v) => `f(${k}="${v}")`,
  (k, v) => `https://ci.test/run?${k}=${v}&next=1`,
  (k, v) => JSON.stringify({ [k]: v }),
  (k, v) => JSON.stringify({ a: 1, [k]: v, b: true }, null, 2),
  (k, v) => JSON.stringify(JSON.stringify({ [k]: v })),
  (k, v) => JSON.stringify({ log: `${k}=${v}` }),
  (k, v) => JSON.stringify({ environment: [{ name: k, value: v }] }),
  (k, v) => JSON.stringify(JSON.stringify([{ name: k, value: v }])),
  (k, v) => `{ name: '${k}', value: '${v}' }`,
  (k, v) => `- name: ${k}\n  value: ${v}`,
  (k, v) => `- name: ${k}\r\n  value: "${v}"`,
];

/** Bare credentials in text, logs and JSON (after an escaped newline or tab, too). */
const TOKEN_WRITINGS: ReadonlyArray<(token: string) => string> = [
  (t) => `deploy with ${t} now`,
  (t) => `Authorization: Bearer ${t}`,
  (t) => JSON.stringify(`step failed\n${t}`),
  (t) => JSON.stringify(`a\t${t}\r\nb`),
  (t) => JSON.stringify({ headers: { Authorization: `Bearer ${t}` } }),
  (t) => JSON.stringify(JSON.stringify({ log: `failed\n${t}` })),
];

/** Values the redactor keeps, which must not hide a secret written after them. */
const KEPT = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal env reference
  '${DB_PASSWORD}',
  '$API_KEY',
  '$env:API_KEY',
  '<your-token>',
  '1024',
  'true',
  'none',
  'req.headers.token',
  'arn:aws:secretsmanager:us-east-1:000000000000:secret:prod/db-AbCdEf',
  'arn:aws:iam::aws:policy/ReadOnlyAccess',
  '[REDACTED]',
  '',
];

const AROUND = [
  '',
  ' ',
  '\n',
  '\\n',
  '\\t',
  '{',
  '}',
  '[',
  ')',
  ',',
  ';',
  '&',
  '"',
  "'",
  '\\"',
  ':',
  '=',
  'x',
  'Error: ',
  ' and more',
  '{"a":1,',
  ',"b":2}',
  'max_tokens: 1024, ',
];

/** Pieces of keys, separators, quotes, escapes and kept values, joined at random. */
const FRAGMENTS = [
  ...KEYS.slice(0, 6),
  'name',
  'value',
  'value: ',
  '"value":',
  '\\"value\\":',
  '- name: ',
  '\n  value: ',
  '=',
  ':',
  ': ',
  '"',
  "'",
  '\\"',
  '\\',
  ',',
  ' ',
  '\n',
  '\r\n',
  '\\n',
  '\\t',
  '{',
  '}',
  ')',
  '&',
  '?',
  '$',
  '<',
  '>',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal env reference
  '${X}',
  '$env:',
  '<p>',
  '1024',
  'true',
  'Bearer ',
  'secretsmanager',
  'arn:aws:s3:::bucket',
  'arn:aws:secretsmanager:us-east-1:000000000000:secret:x',
  'arn:aws:lambda:us-east-1:000000000000:function:token-rotator:',
];

type Case = { text: string; secret: string };

const CASES: ReadonlyArray<{ name: string; make: () => Case }> = [
  {
    name: 'a secret a key names',
    make: () => {
      const secret = pick(SECRETS)();
      return { secret, text: pick(AROUND) + pick(WRITINGS)(pick(KEYS), secret) + pick(AROUND) };
    },
  },
  {
    name: 'a secret after a value the redactor keeps',
    make: () => {
      const secret = pick(SECRETS)();
      const kept = pick(WRITINGS)(pick(KEYS), pick(KEPT));
      return { secret, text: kept + pick(AROUND) + pick(WRITINGS)(pick(KEYS), secret) };
    },
  },
  {
    name: 'a bare credential',
    make: () => {
      const secret = pick(TOKENS)();
      return { secret, text: pick(AROUND) + pick(TOKEN_WRITINGS)(secret) + pick(AROUND) };
    },
  },
  {
    name: 'random fragments around a secret',
    make: () => {
      const secret = random() < 0.5 ? run(14) : pick(TOKENS)();
      const parts = Array.from({ length: 3 + Math.floor(random() * 10) }, () => pick(FRAGMENTS));
      parts.splice(Math.floor(random() * (parts.length + 1)), 0, secret);
      return { secret, text: parts.join('') };
    },
  },
];

/** Whether six letters or digits in a row of the secret show in the text. */
function shows(text: string, secret: string): boolean {
  for (const part of secret.split(/[^A-Za-z0-9]+/)) {
    for (let i = 0; i + 6 <= part.length; i++) if (text.includes(part.slice(i, i + 6))) return true;
  }
  return false;
}

const S = 'Q7x4R2m9K3';
const SK = ['sk-', 'a'.repeat(30)].join('');

/** Hand-written inputs, one for each way a longer match could cover what the baseline masked. */
const EDGES = [
  // A JSON string with an escaped quote: what follows it may not assign or be assigned to.
  `password: "x\\" token"=${S}`,
  `password: "x\\" token:'a" ${S}'`,
  // Base64 padding: a single `=` after a key assigns.
  `{ name: 'DB_PASSWORD', value: 'token=' ${S}' }`,
  `{ name: 'DB_PASSWORD', value: 'token =' ${S}' }`,
  `- name: DB_PASSWORD\n  value: token= ${S}`,
  `{\\"password\\":\\"token='\\" ${S}'`,
  // A name/value entry's value may not run into the next key, or hide one.
  `- name: DB_PASSWORD\n  value: noneapiKey = "${S}"`,
  `{ name: 'X_TOKEN', value: '\${X} token=${S}' }`,
  `{ name: 'X_TOKEN', value: arn:aws:s3:::token:${S} }`,
  // A token after an escaped newline may not swallow a key.
  `"step\\n${SK}password=${S}"`,
  `\\nBearer db.passwordDB_PASSWORDarn:${S}`,
  // Only a string inside a JSON string loses escaped quotes before the checks.
  `password: "db.password${S}value\\"x'`,
];

describe('redactSecrets against the redactor before task-21', () => {
  it.each(EDGES)('never shows what the baseline masked: %s', (text) => {
    if (!shows(baseline(text), S)) expect(redactSecrets(text)).not.toContain(S.slice(0, 6));
  });

  it.each(CASES)('never shows what the baseline masked: $name', ({ make }) => {
    const shown: object[] = [];
    const unstable: object[] = [];
    for (let i = 0; i < 3_000; i++) {
      const { text, secret } = make();
      const before = baseline(text);
      const after = redactSecrets(text);
      if (!shows(before, secret) && shows(after, secret)) shown.push({ text, before, after });
      if (redactSecrets(after) !== after) unstable.push({ text, after });
    }
    expect(shown.slice(0, 5)).toEqual([]);
    expect(unstable.slice(0, 5)).toEqual([]);
  });
});
