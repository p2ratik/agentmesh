import { parseCommandArgs } from '../../args';
import type { Command } from '../../context';
import { renderStatus } from '../../setup/render/status';
import { loadAnswers, readState, workspaceFrom } from '../../setup/workspace';

export const setupStatusCommand: Command = {
  name: 'setup status',
  summary: 'Show which setup steps are done and what to run next',
  help: 'Usage: agentmesh setup status --dir <workspace>',
  run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { dir: { type: 'string' } },
      { min: 0, max: 0, names: '' },
    );
    const p = workspaceFrom(ctx, values.dir);
    ctx.stdout(renderStatus(readState(p), loadAnswers(p)));
    return 0;
  },
};
