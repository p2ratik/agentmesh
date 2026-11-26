// The server bundle's (task_get): reads git's files and never spawns git.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path, { join, sep } from 'node:path';
import { parseRemote } from '../git';
import { badInput } from '../guard/paths';

const NO_REPO = 'checkout: this task names no repo. Ask your human which checkout to use.';
const BAD_REPO =
  "checkout: this task's repo isn't owner/name. Ask your human which checkout to use.";
/** The only repo shape echoed into tool output: one line, no path or shell characters. */
const OWNER_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** A worktree's `.git` file is one line; a repo's config is a few KB. */
const MAX_GIT_FILE = 4096;
const MAX_CONFIG = 64 * 1024;

/** A repo as compared: case-insensitive, without a `.git` suffix. For matching only. */
export const repoKey = (repo: string): string => repo.replace(/\.git$/i, '').toLowerCase();

/** Whether the hub's repo may be used and printed: the text as sent is a plain owner/name (event
 * rules fill it). Checked before any case folding, which can turn a non-ASCII letter into ASCII. */
export const isOwnerName = (repo: string): boolean => OWNER_NAME.test(repo.replace(/\.git$/i, ''));

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
 * subsection name is case-sensitive, as in git. Any other header ends the section, even one this
 * doesn't parse (an escaped quote in its name). */
function originUrl(config: string): string | null {
  let origin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"\\]*)")?\s*\]/.exec(line);
      origin = section?.[1]?.toLowerCase() === 'remote' && section[2] === 'origin';
      continue;
    }
    const entry = origin ? /^([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/.exec(line) : null;
    if (entry?.[1]?.toLowerCase() === 'url') return configValue(entry[2] ?? '');
  }
  return null;
}

/**
 * `<X>/.git` for a worktree's `gitdir:` target `<X>/.git/worktrees/<name>`, from the text alone
 * (`..` folded): null for any other target, and for a UNC, device or stream spelling
 * (guard/paths.ts `badInput`), so no UNC or device spelling is opened.
 */
export function worktreeCommonDir(
  dir: string,
  target: string,
  platform: NodeJS.Platform,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const resolved = p.resolve(dir, target);
  if (badInput(resolved, { platform, home: '' })) return null;
  const worktrees = p.dirname(resolved);
  const common = p.dirname(worktrees);
  return p.basename(worktrees) === 'worktrees' && p.basename(common) === '.git' ? common : null;
}

/**
 * The repo's own `.git` folder: `dir/.git` when it is a real folder. With `followWorktree`, a
 * `.git` file (a small regular file) whose `gitdir:` is `<X>/.git/worktrees/<name>` gives
 * `<X>/.git` when that is a real folder. `commondir` is never read, so a checkout's files can steer
 * the read to nothing but a `.git/config`.
 */
function gitDir(dir: string, followWorktree: boolean): string | null {
  const dotGit = join(dir, '.git');
  const stat = lstatSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  if (!followWorktree || !stat.isFile() || stat.size > MAX_GIT_FILE) return null;
  // As git reads it: one line, its line break dropped; a trailing space stays (and is refused).
  const line = readFileSync(dotGit, 'utf8').replace(/[\r\n]+$/, '');
  const target = /^gitdir: (.+)$/.exec(line)?.[1];
  const common = target ? worktreeCommonDir(dir, target, process.platform) : null;
  return common && lstatSync(common).isDirectory() ? common : null;
}

/**
 * `owner/name` of a checkout's origin, read from its .git/config. Null unless .git is a real
 * folder, or with `followWorktree` (the window's local sessions line) a worktree of one. Checkouts
 * never follow: a worktree next to its checkout is not a second checkout.
 */
export function originRepo(dir: string, followWorktree = false): string | null {
  try {
    const dotGit = gitDir(dir, followWorktree);
    if (!dotGit) return null;
    const config = join(dotGit, 'config');
    // Never a FIFO, a device or a link (to /dev/zero, say): the read would hang the server.
    const stat = lstatSync(config);
    if (!stat.isFile() || stat.size > MAX_CONFIG) return null;
    // ponytail: no include/includeIf handling; add if real configs need it
    const url = originUrl(readFileSync(config, 'utf8'));
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
  const want = repoKey(repo);
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
  if (!isOwnerName(repo)) return BAD_REPO;
  const found = findCheckout(repo, folder);
  return `checkout: ${'path' in found ? found.path : found.problem}`;
}
