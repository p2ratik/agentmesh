// Node built-ins only; never spawns git.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parseRemote } from '../git';

const NO_REPO = 'checkout: this task names no repo. Ask your human which checkout to use.';
const BAD_REPO =
  "checkout: this task's repo isn't owner/name. Ask your human which checkout to use.";
/** The only repo shape echoed into tool output: one line, no path or shell characters. */
const OWNER_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** A git config value as git reads it: double quotes dropped, a `\` escape kept as the escaped
 * character, an unquoted `;` or `#` starting a comment. */
function configValue(raw: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '\\') out += raw[++i] ?? '';
    else if (!quoted && (ch === ';' || ch === '#')) break;
    else out += ch;
  }
  return out.trim();
}

/** The first `url` of `[remote "origin"]`. Section and key names match in any case; the
 * subsection name is case-sensitive, as in git. */
function originUrl(config: string): string | null {
  let origin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
    if (section) {
      origin = section[1]?.toLowerCase() === 'remote' && section[2] === 'origin';
      continue;
    }
    const entry = origin ? /^([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/.exec(line) : null;
    if (entry?.[1]?.toLowerCase() === 'url') return configValue(entry[2] ?? '');
  }
  return null;
}

/** `owner/name` of a checkout's origin, read from .git/config. Null unless .git is a real folder. */
export function originRepo(dir: string): string | null {
  try {
    const dotGit = join(dir, '.git');
    if (!lstatSync(dotGit).isDirectory()) return null; // a worktree's .git file, or a link
    // ponytail: no include/includeIf handling; add if real configs need it
    const url = originUrl(readFileSync(join(dotGit, 'config'), 'utf8'));
    return (url && parseRemote(url)) || null;
  } catch {
    return null;
  }
}

/** A path as tool output shows it: forward slashes on Windows, where the guard's `cd` takes
 * `C:/…` and asks for a backslash. */
const shown = (p: string) => (sep === '\\' ? p.replaceAll('\\', '/') : p);

/** The folder itself and its direct subfolders (never a link) whose origin is `repo`, compared
 * case-insensitively and without a `.git` suffix. */
export function findCheckout(repo: string, folder: string): { path: string } | { problem: string } {
  const want = repo.replace(/\.git$/i, '').toLowerCase();
  let dirs = [folder];
  try {
    dirs = dirs.concat(
      readdirSync(folder, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(folder, e.name)),
    );
  } catch {
    // unreadable folder: no matches
  }
  const paths = dirs.filter((d) => originRepo(d)?.toLowerCase() === want).map(shown);
  if (paths.length === 1) return { path: paths[0] as string };
  if (paths.length === 0) {
    return {
      problem: `no git checkout in ${shown(folder)} has origin ${repo}. Ask your human for its path; never clone it.`,
    };
  }
  return {
    problem: `${paths.length} checkouts in ${shown(folder)} have origin ${repo} (${paths.join(', ')}). Ask your human which one to use.`,
  };
}

/** The line task_get adds in the mesh window. The hub's repo is echoed only as plain owner/name:
 * event rules fill it from external payloads. */
export function checkoutLine(repo: string | null, folder: string): string {
  if (!repo) return NO_REPO;
  if (!OWNER_NAME.test(repo.replace(/\.git$/i, ''))) return BAD_REPO;
  const found = findCheckout(repo, folder);
  return `checkout: ${'path' in found ? found.path : found.problem}`;
}
