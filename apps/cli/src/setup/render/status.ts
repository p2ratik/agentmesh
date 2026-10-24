import type { SetupAnswers } from '../answers';
import { type SetupState, STEPS, type StepName } from '../workspace';

/** Nothing is written before the admin confirms the answers, even when setup resumes. */
const BEFORE_RENDER = 'confirm the answers (setup render --dry-run), then run setup render';
const BEFORE_RERENDER = `${BEFORE_RENDER} --force (the hosting changed)`;
/** The round trip needs an active session, so activation comes before the proof. */
const AFTER_ADMIN =
  'run /agentmesh:activate, then the proof (doctor, peers, hello), then setup invites';

/** Where a setup workspace stands: each step, then what to run next. Pure. */
export function renderStatus(state: SetupState, answers: SetupAnswers | null): string {
  const trial = answers?.hosting.mode === 'trial';
  const skipped = (step: StepName) => trial && step === 'host';
  const lines = STEPS.map((step) => {
    const at = state.done[step];
    const status = at ? `done ${at.slice(0, 10)}` : skipped(step) ? 'not needed (trial)' : 'to do';
    return `  ${step.padEnd(8)} ${status}`;
  });
  const next = STEPS.find((step) => !state.done[step] && !skipped(step));
  // Hosting edited since the last render (a trial going real): render again first.
  const moved = answers !== null && state.mode !== undefined && state.mode !== answers.hosting.mode;
  const todo = moved
    ? BEFORE_RERENDER
    : next === 'render'
      ? BEFORE_RENDER
      : next
        ? `run setup ${next}`
        : AFTER_ADMIN;
  const where = !answers
    ? ''
    : answers.hosting.mode === 'server'
      ? ` on ${answers.hosting.publicHost}`
      : ' (trial on this machine)';
  return [
    `AgentMesh setup${answers ? ` for ${answers.team.name}` : ''}${where}`,
    ...lines,
    `Next: ${todo}`,
  ].join('\n');
}
