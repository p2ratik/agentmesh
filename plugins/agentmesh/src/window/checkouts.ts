// Node built-ins only; never spawns git.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRemote } from '../git';

/** `owner/name` of a checkout's origin, read from .git/config. Null unless .git is a real folder. */
export function originRepo(dir: string): string | null {
  try {
    const dotGit = join(dir, '.git');
    if (!lstatSync(dotGit).isDirectory()) return null; // a worktree's .git file, or a link
    const config = readFileSync(join(dotGit, 'config'), 'utf8');
    // ponytail: no include/includeIf handling; add if real configs need it
    const section = /^\s*\[remote "origin"\][^[]*/m.exec(config)?.[0] ?? '';
    const url = /^\s*url\s*=\s*(.+?)\s*$/m.exec(section)?.[1];
    return (url && parseRemote(url)) || null;
  } catch {
    return null;
  }
}

/** The folder itself and its direct subfolders whose origin is `repo` (case-insensitive). */
export function findCheckout(repo: string, folder: string): { path: string } | { problem: string } {
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
  const paths = dirs.filter((d) => originRepo(d)?.toLowerCase() === repo.toLowerCase());
  if (paths.length === 1) return { path: paths[0] as string };
  if (paths.length === 0) {
    return {
      problem: `no git checkout in ${folder} has origin ${repo}. Ask your human for its path; never clone it.`,
    };
  }
  return {
    problem: `${paths.length} checkouts in ${folder} have origin ${repo} (${paths.join(', ')}). Ask your human which one to use.`,
  };
}

export function checkoutLine(repo: string | null, folder: string): string {
  if (!repo) return 'checkout: this task names no repo. Ask your human which checkout to use.';
  const found = findCheckout(repo, folder);
  return `checkout: ${'path' in found ? found.path : found.problem}`;
}
