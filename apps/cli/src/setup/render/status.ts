import type { SetupAnswers } from '../answers';
import { type SetupState, STEPS, type StepName } from '../workspace';

const AFTER_ADMIN = 'run doctor, then /agentmesh:activate, then setup invites';

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
  const where = !answers
    ? ''
    : answers.hosting.mode === 'server'
      ? ` on ${answers.hosting.publicHost}`
      : ' (trial on this machine)';
  return [
    `AgentMesh setup${answers ? ` for ${answers.team.name}` : ''}${where}`,
    ...lines,
    `Next: ${next ? `run setup ${next}` : AFTER_ADMIN}`,
  ].join('\n');
}
