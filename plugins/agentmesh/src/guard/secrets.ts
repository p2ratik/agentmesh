// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. Whether a shell command
// would read a secret: name a secret file, print a stored credential, dump the environment or read
// a secret-named variable. In the mesh window that is refused in every mode, before the command
// list. Matching is by pattern over the command text, case-insensitive: a false positive refuses,
// which is the safe side. Other single variables and obfuscated forms are not seen.
import {
  CLAUDE_ACCOUNT_FILES,
  SECRET_HOME_PATHS,
  SECRET_NAMES,
} from '@agentmesh/common/secret-paths';
import type { ReasonCode } from '@agentmesh/protocol/observe-codes';

/** Where a command word starts: a piece's start, after a space, or as a path's last name. */
export const AT = String.raw`(?:^|[\s/\\])`;
export const END = String.raw`(?=\s|$)`;

/** A character of a file name: a path token starts and ends next to anything else. */
const NAME = String.raw`[\w.-]`;
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A deny glob as a token pattern: its folder (`.ssh/**` is `.ssh`), `*` within one name, either
 * slash between names, and a space that may be escaped. */
function token(glob: string): string {
  const parts = glob.replace(/\/\*\*$/, '').split('*');
  const spelled = parts.map((p) =>
    literal(p).replaceAll('/', String.raw`[/\\]`).replaceAll(' ', String.raw`\\? `),
  );
  return spelled.join(`${NAME}*`);
}

/** A secret file's name: never `process.env` or `import.meta.env` in code, and never a folder
 * (`.env/` is a virtualenv). A home path may go on into its folder. */
const fileToken = (glob: string) =>
  String.raw`(?!(?:process|(?:import\.)?meta)\.env\b)${token(glob)}(?![\w.\-/\\])`;
const homeToken = (glob: string) => `${token(glob)}(?!${NAME})`;

const SECRET_PATH = new RegExp(
  `(?<!${NAME})(?:${[
    ...[...SECRET_NAMES, ...CLAUDE_ACCOUNT_FILES].map(fileToken),
    ...SECRET_HOME_PATHS.map(homeToken),
  ].join('|')})`,
  'i',
);

const CONTINUATION = /\\\r?\n/g;
/** A line continuation as a space, so the pieces split where the shell's words do. */
export const unfold = (command: string): string => command.replace(CONTINUATION, ' ');

/** What splits a command into the pieces a shell runs on their own (and quoted text). */
const SEPARATORS = /&&|\|\||\$\(|[;&|\n\r()`{}"'<>]/;

/** The command's pieces, trimmed, with runs of whitespace as one space. */
export const segments = (command: string): string[] =>
  unfold(command)
    .split(SEPARATORS)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

/** A command that prints a stored credential: gh's token, or git's credential helpers. */
const CREDENTIAL = new RegExp(
  [
    String.raw`${AT}gh(?:\.exe)?\s(?:.*\s)?auth\s(?:.*\s)?(?:token|status\s(?:.*\s)?(?:--show-token|-t))${END}`,
    String.raw`${AT}git(?:\.exe)?(?:\s(?:.*\s)?|-)credential(?:-[\w.-]+)?(?:\.exe)?\s(?:.*\s)?(?:fill|get)${END}`,
  ].join('|'),
  'i',
);

/** `printenv` anywhere, a process's environment file, .NET's whole environment, and a runtime
 * printing its whole environment object. */
const DUMP_ANYWHERE = new RegExp(
  [
    String.raw`(?<![\w-])printenv(?![\w-])`,
    String.raw`\/proc\/[^/\s]+\/environ`,
    String.raw`GetEnvironmentVariables\s*\(`,
    String.raw`(?<![\w-])(?:node|nodejs|bun|deno)(?:\.exe)?\s[\s\S]*process\.env(?![\w.$[])`,
    String.raw`(?<![\w-])(?:python[\d.]*|py)(?:\.exe)?\s[\s\S]*os\.environ(?:\.(?:items|keys|values|copy)\(\s*\))?(?![\w.[])`,
  ].join('|'),
  'i',
);

/** Wrappers that run what follows them. */
const WRAP = String.raw`(?:(?:sudo|doas|command|exec|nohup|time|builtin)(?: -\S+)* )*`;
/** `env` with nothing to run: only options and assignments, so it prints the environment. */
const ENV_ALONE = String.raw`(?:\S*[/\\])?env(?:\.exe)?(?: (?:-0|--null|-i|--ignore-environment|-u(?: ?\S+)?|--unset=\S+|[A-Za-z_]\w*=\S*))*`;
/** A piece that is a whole dump: `env` alone, `export` with none or `-p`, `declare -x|-p`, `set`
 * alone or through cmd, or a PowerShell cmdlet reading the env: drive. */
const DUMP_SEGMENT = new RegExp(
  String.raw`^${WRAP}(?:${ENV_ALONE}|export(?: -p)?|(?:declare|typeset) -[xp]|set|(?:\S*[/\\])?cmd(?:\.exe)? \/[ck] set|(?:get-childitem|gci|ls|dir|get-item|gi|get-content|gc|cat|type)(?: .*)? env:.*)$`,
  'i',
);

/** A single variable read: `$NAME`, `${NAME}`, `$env:NAME`, `%NAME%`, .NET's
 * `GetEnvironmentVariable('NAME')`, and Node's and Python's spellings. */
const VARIABLE =
  /\$\{?(?:env:)?([A-Za-z_]\w*)|%([A-Za-z_]\w*)%|GetEnvironmentVariable\(\s*["']([A-Za-z_]\w*)|(?:process\.env\.|process\.env\[\s*["']|environ\[\s*["']|environ\.get\(\s*["']|getenv\(\s*["'])([A-Za-z_]\w*)/gi;
const SECRET_VARIABLE = /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE_?KEY|SEED|CREDENTIAL|AUTH/i;
const isSecretVariable = (name: string) =>
  SECRET_VARIABLE.test(name) || name.toUpperCase() === 'AGENTMESH_MESH_WINDOW';
const readsSecretVariable = (text: string) =>
  [...text.matchAll(VARIABLE)].some((m) => isSecretVariable(m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''));

/** Why `command` must be refused: it names a secret file (also when a line continuation splits
 * the name), prints a stored credential, or dumps the environment or a secret-named variable (the
 * window's own environment holds its marker token). Null when it does none of these. */
export function secretUse(command: string): ReasonCode | null {
  const text = unfold(command);
  if (SECRET_PATH.test(text) || SECRET_PATH.test(command.replace(CONTINUATION, ''))) {
    return 'secret.path';
  }
  const pieces = segments(command);
  if (pieces.some((s) => CREDENTIAL.test(s))) return 'secret.credential';
  const dumps = DUMP_ANYWHERE.test(text) || pieces.some((s) => DUMP_SEGMENT.test(s));
  return dumps || readsSecretVariable(text) ? 'secret.env_dump' : null;
}
