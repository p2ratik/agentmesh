import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './redact';

/**
 * The assignment masking production ran before escape handling (on `agents`):
 * the oracle. `redactSecrets` may mask more than this, never less.
 */
const AGENTS =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}?(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]{0,64}["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;'"&]+)/gi;

function agentsRedact(text: string): string {
  return text.replace(AGENTS, (match, key: string, value: string) => {
    const bare = value.replace(/^["']|["']$/g, '');
    const kept =
      bare === '' ||
      bare === REDACTED ||
      /^\$\{?[A-Za-z_]/.test(bare) ||
      bare.startsWith('<') ||
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(bare) ||
      [
        'string',
        'number',
        'boolean',
        'null',
        'undefined',
        'true',
        'false',
        'unknown',
        'any',
      ].includes(bare.toLowerCase());
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return kept ? match : `${key}${quote}${REDACTED}${quote}`;
  });
}

const SECRETS = ['hunter2X9', 'kP9qL2'];
const count = (text: string, word: string) => text.split(word).length - 1;
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal env reference, as in shell lines
const REF = '${V}';

/** Every secret the oracle masks is masked, and masking again changes nothing. */
function expectNoWorseThanAgents(text: string): void {
  const once = redactSecrets(text);
  const agents = agentsRedact(text);
  for (const secret of SECRETS) {
    if (count(once, secret) > count(agents, secret)) {
      throw new Error(`${JSON.stringify(text)} shows ${secret}: ${JSON.stringify(once)}`);
    }
  }
  if (redactSecrets(once) !== once) {
    throw new Error(`${JSON.stringify(text)} is not idempotent: ${JSON.stringify(once)}`);
  }
}

describe('redactSecrets against the redactor it replaces', () => {
  it('never shows a secret the old one masked, after a value that ends in a backslash', () => {
    // The escape-aware reading ran on into the next assignment and swallowed its key.
    expect(redactSecrets('--token-dir="C:\\keys\\" --password="hunter2X9"')).not.toContain(
      'hunter2X9',
    );
    expect(redactSecrets('TOKEN_DIR="$HOME\\" PASSWORD="hunter2X9"')).toBe(
      'TOKEN_DIR="$HOME\\" PASSWORD="[REDACTED]"',
    );
    expect(
      redactSecrets('$env:SECRET_DIR="C:\\keys\\"; $env:DB_PASSWORD="hunter2-prod"'),
    ).not.toContain('hunter2-prod');
  });

  it('holds on a corpus of assignment shapes', () => {
    const corpus = [
      '--token-dir="C:\\keys\\" --password="hunter2X9"',
      'TOKEN_DIR="$HOME\\" PASSWORD="hunter2X9"',
      `TOKEN_DIR="${REF}\\" PASSWORD="hunter2X9"`,
      'TOKEN_DIR="<dir>\\" PASSWORD="hunter2X9"',
      "token_dir='C:\\k\\' password='hunter2X9'",
      '$env:SECRET_DIR="C:\\keys\\"; $env:DB_PASSWORD="hunter2X9"',
      'token="\\" password=\\"hunter2X9 x',
      '{"DB_PASSWORD":"Xy7\\"kP9qL2","b":1}',
      '{"message":"DB_PASSWORD=\\"hunter2X9\\" failed"}',
      '{"body":"{\\"password\\":\\"hunter2X9\\"}"}',
      'password="correct horse\\" kP9qL2',
      `api_key=${REF} password=hunter2X9`,
      `token=\\"${REF} password=hunter2X9\\"`,
      `secret="${REF}\\"x password="hunter2X9"`,
      'password=hunter2X9&token=kP9qL2',
      'password: \'hunter2X9\', token: "kP9qL2"',
    ];
    for (const text of corpus) expectNoWorseThanAgents(text);
  });

  it('holds on seeded fuzz inputs', () => {
    // A small PRNG (mulberry32), so a failure reproduces.
    let seed = 20261021;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (options: readonly string[]) =>
      options[Math.floor(random() * options.length)] ?? '';
    const QUOTES = ['', '', '"', "'", '\\"', "\\'"];
    const CONTENT = [...SECRETS, ...SECRETS, '$HOME', REF, '<p>', 'C:\\k\\', 'a b', 'x.y'];
    const MORE = [...CONTENT, 'true', '\\', '\\"', '"', "'", REDACTED];
    // Whole assignments, so the shapes that matter (a value ending in `\` before the next key,
    // escaped quotes, unclosed quotes) come up often.
    const assignment = () =>
      pick(['password', 'TOKEN_DIR', 'api_key', 'secret', 'x']) +
      pick(['', '', '"', '\\"', "'"]) +
      pick(['=', ':', ': ']) +
      pick(QUOTES) +
      pick(CONTENT) +
      (random() < 0.5 ? pick(MORE) : '') +
      pick(QUOTES);
    for (let i = 0; i < 20_000; i++) {
      let text = pick(['', '{', '"', '\\"']);
      const parts = 1 + Math.floor(random() * 3);
      for (let j = 0; j < parts; j++) {
        text += assignment() + pick([' ', ' --', ', ', '; ', '&', '\n', '}', '"', '']);
      }
      expectNoWorseThanAgents(text);
    }
  });
});
