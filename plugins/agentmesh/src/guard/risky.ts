// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. The floor the guard keeps
// in auto mode: a command off the window's list goes to auto mode's checks unless one of its pieces
// pushes, merges, rewrites or deletes work, changes things through gh, or reaches infrastructure;
// then the human decides. Patterns match anywhere in any piece (`&&`, `;`, `|`, `$(…)`, quotes,
// line continuations), so a compound command can't hide one. Over-matching asks, the safe side.
import type { WindowPolicy } from '@agentmesh/common/window';
import { AT, END, segments, unfold } from './secrets';

/** `git` (or `gh`), any arguments, then `rest` as a whole word. */
const git = (rest: string) => String.raw`${AT}git(?:\.exe)?\s(?:.*\s)?${rest}${END}`;
const gh = (rest: string) => String.raw`${AT}gh(?:\.exe)?\s(?:.*\s)?${rest}${END}`;
const any = (s: string) => String.raw`\s(?:.*\s)?${s}`;

const RISKY = [
  git('(?:push|merge|restore)'),
  git(`branch${any('(?:-[a-z]*d[a-z]*|--delete)')}`),
  git(`reset${any('--hard')}`),
  git(`checkout${any(String.raw`(?:--|\.)`)}`),
  git(`stash${any('(?:drop|clear)')}`),
  // any forced git command: clean -f, worktree remove --force, checkout -f, add -f, rm -rf
  git(String.raw`(?:--force[\w-]*|-[a-z]*f[a-z]*)`),
  gh(`pr${any(`(?:merge|review${any('(?:--approve|-a)')})`)}`),
  gh(
    `(?:workflow${any('run')}|run${any('rerun')}|release${any('(?:create|delete)')}|repo${any('delete')}|secret|variable${any('(?:set|delete)')})`,
  ),
  // gh api writes: an explicit method, or fields, which make it a POST
  gh(
    `api${any(String.raw`(?:(?:-X\s?|--method[\s=])(?:DELETE|PUT|POST|PATCH)|-[fF]|--field|--raw-field|--input)`)}`,
  ),
  String.raw`${AT}docker(?:\.exe)?\s(?:.*\s)?(?:push|--push(?:=\S*)?)${END}`,
  String.raw`${AT}(?:terraform|pulumi|kubectl|helm|az|aws|gcloud|ssh|scp|rsync)(?:\.exe|\.cmd)?${END}`,
].map((r) => new RegExp(r, 'i'));
const REBASE = new RegExp(git('rebase'), 'i');

/** `git rebase <integration branch>`, in any of its spellings, alone in its piece: keeping a branch
 * rebased is routine, it rewrites only the local branch, and the force push it needs asks. */
function ontoIntegration(piece: string, p: WindowPolicy): boolean {
  const b = p.integrationBranch;
  return [b, `origin/${b}`, `refs/remotes/origin/${b}`].some(
    (ref) => piece === `git rebase ${ref}`,
  );
}

/** Whether `command` must ask the human even in auto mode. */
export function risky(command: string, p: WindowPolicy): boolean {
  return segments(command).some(
    (s) => RISKY.some((r) => r.test(s)) || (REBASE.test(s) && !ontoIntegration(s, p)),
  );
}

/** Searches that read every file under a folder, untracked and hidden ones included (a checkout's
 * `.env`): recursive grep (not git grep, which reads tracked files), rg past its ignore rules,
 * findstr /s and recursive Select-String. */
const SEARCH = [
  String.raw`(?<![\w-])(?<!git(?:\.exe)? (?:-\S+ )*)[ef]?grep(?:\.exe)?${any('(?:-[a-z]*r[a-z]*|--(?:dereference-)?recursive|--directories=recurse|-d ?recurse)')}${END}`,
  String.raw`(?<![\w-])rg(?:\.exe)?${any(String.raw`(?:--hidden|--unrestricted|--no-ignore[\w-]*|-[a-z.]*[u.][a-z.]*)`)}${END}`,
  String.raw`(?<![\w-])findstr(?:\.exe)?${any(String.raw`\/[a-z:]*s[a-z:]*`)}${END}`,
  String.raw`(?<![\w-])(?:select-string|sls)${any('-r[a-z]*')}${END}`,
].map((r) => new RegExp(r, 'i'));
/** Get-ChildItem -Recurse piped into Select-String, across pieces. */
const PIPED =
  /(?<![\w-])(?:get-childitem|gci|ls|dir)\s[^;\n]*?-r[a-z]*(?=\s|\|)[^;\n]*?\|\s*(?:select-string|sls)\b/i;

/** Whether `command` searches recursively; auto mode lets it through only inside a mesh worktree. */
export const recursiveSearch = (command: string): boolean =>
  segments(command).some((s) => SEARCH.some((r) => r.test(s))) || PIPED.test(unfold(command));
