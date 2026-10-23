import { agentIdOf, everyone, type SetupAnswers } from '../answers';
import { MAX_POLICY_CHARS } from '../defaults';

/**
 * The bullets of config/examples/policy/team-policy.md, with the team's branches. With the
 * default branches (`agents`, `main`) they equal the example; a test keeps them in step.
 */
function workingRules(git: SetupAnswers['git']): string {
  const into = `\`${git.integrationBranch}\``;
  const promoted = git.protectedBranches.map((b) => `\`${b}\``).join(', ');
  return `- Definition of done: tests pass in CI, the PR description explains the change, and docs are
  updated when behaviour changes.
- Keep PRs under ~400 changed lines; split bigger work into dependent tasks.
- Every PR needs at least one peer review before it is merged into ${into}.
- Humans promote ${into} → ${promoted}. Never push to ${promoted} yourself.
- Ask the owner of an area before changing its public contracts (APIs, schemas, events).
- Prefer async: put questions in the task thread instead of starting new threads.
- Escalate to your human before touching infrastructure, secrets, billing or customer data.`;
}

/** `config/policy/team-policy.md`: who the team is and how it decides, for every agent. */
export function renderPolicy(a: SetupAnswers): { text: string; warnings: string[] } {
  const people = everyone(a);
  const finalSay = people.find((p) => p.id === a.decisions.finalSay);
  const text = [
    `## About ${a.team.name}`,
    '',
    a.team.overview,
    ...(a.team.repos.length > 0 ? ['', `Repos: ${a.team.repos.join(', ')}`] : []),
    '',
    '## People',
    '',
    ...people.map(
      (p) =>
        `- ${p.name} (${agentIdOf(p.id)})${p.roles.length > 0 ? `: ${p.roles.join(', ')}` : ''}`,
    ),
    '',
    '## Decisions',
    '',
    `- ${finalSay?.name ?? a.decisions.finalSay} (${a.decisions.finalSay}) has the final say. ` +
      `Escalate crucial decisions to them (\`escalate\` with \`to: ${a.decisions.finalSay}\`).`,
    ...(a.decisions.plansNeedApproval
      ? ['- Plans wait for a human to run `/plan approve` before they become tasks.']
      : []),
    '',
    '## Working rules',
    '',
    workingRules(a.git),
    '',
  ].join('\n');
  const warnings =
    text.length > MAX_POLICY_CHARS
      ? [
          `The team policy is ${text.length} characters (over ${MAX_POLICY_CHARS}). Agents get ` +
            'only the first 4096 characters of their instructions, so shorten the overview or the rules.',
        ]
      : [];
  return { text, warnings };
}
