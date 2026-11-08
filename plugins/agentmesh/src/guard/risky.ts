// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. The floor the guard keeps
// in auto mode: a command off the window's list goes to auto mode's checks unless one of its pieces
// pushes, merges, rewrites or deletes work, or reaches infrastructure; then the human decides.
// Patterns match anywhere in any piece (`&&`, `;`, `|`, `$(…)`, quotes), so a compound command
// can't hide one. Over-matching asks, which is the safe side.
import type { WindowPolicy } from '@agentmesh/common/window';
import { segments } from './secrets';

/** Where a command word starts: a piece's start, after a space, or as a path's last name. */
const AT = String.raw`(?:^|[\s/\\])`;
const END = String.raw`(?=\s|$)`;
/** `git`, any arguments, then `rest` as a whole word. */
const git = (rest: string) => String.raw`${AT}git(?:\.exe)?\s(?:.*\s)?${rest}${END}`;

const RISKY = [
  git('(?:push|merge|restore)'),
  git(String.raw`branch\s(?:.*\s)?(?:-[a-z]*d[a-z]*|--delete)`),
  git(String.raw`reset\s(?:.*\s)?--hard`),
  git(String.raw`checkout\s(?:.*\s)?--`),
  // any forced git command: clean -f, worktree remove --force, checkout -f, add -f, rm -rf
  git(String.raw`(?:--force[\w-]*|-[a-z]*f[a-z]*)`),
  String.raw`${AT}gh(?:\.exe)?\s(?:.*\s)?pr\s(?:.*\s)?merge${END}`,
  String.raw`${AT}docker(?:\.exe)?\s(?:.*\s)?push${END}`,
  String.raw`${AT}(?:terraform|pulumi|kubectl|helm|az|aws|gcloud|ssh|scp)(?:\.exe|\.cmd)?${END}`,
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
