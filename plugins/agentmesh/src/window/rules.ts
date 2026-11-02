// Built-ins only (type-only imports): the guard and hook bundles may import this.
import type { WindowPolicy } from '@agentmesh/common/window';

/** What the mesh window's session is told at session start and on every activation. */
export function windowRules(policy: WindowPolicy | null): string {
  const who = policy ? `${policy.agentId}'s` : "your agent's";
  const base = policy ? policy.integrationBranch : '<integration branch>';
  return [
    `AgentMesh: this session is ${who} mesh window. It takes the team's work: tasks, reviews and teammates' questions.`,
    "- One task at a time, in order. Answer teammates' questions between steps.",
    `- Every piece of work gets its own worktree in the repo's checkout under this folder: cd to the checkout, run git fetch origin, then git worktree add .claude/worktrees/mesh-<task>-<slug> -b <suggested branch> origin/${base}. Edits anywhere else are refused.`,
    "- Never clone a repo. If its checkout isn't in this folder, ask your human for the path.",
    '- Remove a worktree with git worktree remove .claude/worktrees/mesh-<name> once its PR is merged.',
    '- Commits, pushes and PRs ask your human; that is expected. Escalate before anything risky.',
    "- Never activate with pull: true here. If the test message doesn't arrive, call activate again.",
  ].join('\n');
}
