import { everyone, type SetupAnswers } from '../answers';

const MAX_LINES = 25;
/** Team, the People and Areas headings, Hosting, Decisions, Git. */
const FIXED_LINES = 6;

const row = (label: string, value: string): string => `${`${label}:`.padEnd(11)} ${value}`;
const list = (items: string[]): string => (items.length > 0 ? items.join(', ') : 'none');

/** The one-screen summary the admin confirms before anything is written (at most 25 lines). */
export function renderAnswersSummary(a: SetupAnswers): string {
  const { team, decisions, git, hosting } = a;
  const members = everyone(a);
  const people = members.map(
    (p) => `${p.name} (${p.id}): roles ${list(p.roles)}; skills ${list(p.skills)}`,
  );
  const areas = a.areas.map(
    (area) => `${area.id}: ${area.description} (owners ${area.owners.join(', ')})`,
  );
  // A big team folds each list onto one line so the summary still fits on a screen.
  const fold = people.length + areas.length > MAX_LINES - FIXED_LINES;
  const block = (label: string, items: string[]): string[] =>
    fold ? [row(label, items.join('; '))] : [`${label}:`, ...items.map((i) => `  ${i}`)];
  const finalSay = members.find((p) => p.id === decisions.finalSay)?.name;
  return [
    row(
      'Team',
      `${team.name} (mesh "${team.meshName}")` +
        (team.repos.length > 0 ? `, repos ${team.repos.join(', ')}` : ''),
    ),
    ...block('People', people),
    ...block('Areas', areas),
    row(
      'Hosting',
      hosting.mode === 'server'
        ? `server ${hosting.publicHost} (ssh ${hosting.ssh}, files in ${hosting.remoteDir})`
        : `trial on this machine${hosting.testAgent ? ` with ${a.admin.id}-test-agent` : ''} ` +
            '(teammates cannot join a trial)',
    ),
    row(
      'Decisions',
      `${finalSay} (${decisions.finalSay}) has the final say; ` +
        (decisions.plansNeedApproval
          ? 'plans wait for /plan approve'
          : 'plans become tasks without approval'),
    ),
    row(
      'Git',
      `agents merge into the ${git.integrationBranch} branch; ` +
        `only humans merge into ${list(git.protectedBranches)}`,
    ),
  ].join('\n');
}
