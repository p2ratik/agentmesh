// Built-ins only (type-only imports): the guard and hook bundles may import this.
import type { WindowPolicy } from '@agentmesh/common/window';

/** What the mesh window's session is told at session start and on every activation. */
export function windowRules(policy: WindowPolicy | null): string {
  const who = policy ? `${policy.agentId}'s` : "your agent's";
  const base = policy ? policy.integrationBranch : '<integration branch>';
  return [
    `AgentMesh: this session is ${who} mesh window. It takes the team's work: tasks, reviews and teammates' questions.`,
    "- One task at a time, in order. Answer teammates' questions between steps.",
    `- Every piece of work gets its own worktree in the repo's checkout under this folder: cd to the checkout, run git fetch origin, then git worktree add .claude/worktrees/mesh-<task>-<slug> -b <suggested branch> --track origin/${base}. Edits anywhere else are refused.`,
    // Full ref spellings: a fetched tag named origin/<branch> outranks the remote branch.
    '- Reviews: read the diff without asking (git fetch origin, then git diff refs/remotes/origin/<base>...refs/remotes/origin/<branch>). Before you run the tests of a branch that isn\'t yours, reply in the task thread with status "working": "Running the tests on <branch> needs my human\'s approval; my verdict waits for it." Then run them in a review worktree (from the checkout, git worktree add .claude/worktrees/mesh-review-<task> refs/remotes/origin/<branch>) as cd <worktree> && <test command>; your human approves the prompt. Remove the review worktree after review_submit.',
    "- Never clone a repo. If its checkout isn't in this folder, ask your human for the path.",
    '- From the checkout, remove a worktree with git worktree remove .claude/worktrees/mesh-<name> once its PR is merged.',
    `- From your own task worktree, commits, pushes to its branch and gh pr create --base ${base} run without asking; merging and anything else ask your human. Escalate before anything risky.`,
    "- Never activate with pull: true here. If the test message doesn't arrive, call activate again.",
  ].join('\n');
}
