// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. Whether a shell command
// would read a secret or print the environment. In the mesh window that is refused in every mode,
// before the command list. Matching is by pattern over the command text, case-insensitive: a false
// positive refuses, which is the safe side.
import {
  CLAUDE_CREDENTIALS,
  SECRET_HOME_PATHS,
  SECRET_NAMES,
} from '@agentmesh/common/secret-paths';
import type { ReasonCode } from '@agentmesh/protocol/observe-codes';

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

const SECRET_PATH = new RegExp(
  `(?<!${NAME})(?:${[...SECRET_NAMES, ...SECRET_HOME_PATHS, CLAUDE_CREDENTIALS].map(token).join('|')})(?!${NAME})`,
  'i',
);

/** What splits a command into the pieces a shell runs on their own (and quoted text). */
const SEPARATORS = /&&|\|\||\$\(|[;&|\n\r()`{}"'<>]/;

/** The command's pieces, trimmed, with runs of whitespace as one space. */
export const segments = (command: string): string[] =>
  command
    .split(SEPARATORS)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

/** `printenv` anywhere, and a process's environment file. */
const DUMP_ANYWHERE = /(?<![\w-])printenv(?![\w-])|\/proc\/[^/\s]+\/environ/i;
/** A piece that is a whole dump: `env` with no argument or `-0`, `export` with none or `-p`,
 * `declare -x|-p`, `set` alone, or a PowerShell cmdlet reading the env: drive. */
const DUMP_SEGMENT =
  /^(?:env(?: -0)?|export(?: -p)?|(?:declare|typeset) -[xp]|set|(?:get-childitem|gci|ls|dir|get-item|gi|get-content|gc|cat|type)(?: .*)? env:.*)$/i;

/** Why `command` must be refused: it names a secret path, or dumps the environment (the window's
 * own holds its marker token). Null when it does neither. */
export function secretUse(command: string): ReasonCode | null {
  if (SECRET_PATH.test(command)) return 'secret.path';
  if (DUMP_ANYWHERE.test(command) || segments(command).some((s) => DUMP_SEGMENT.test(s))) {
    return 'secret.env_dump';
  }
  return null;
}
