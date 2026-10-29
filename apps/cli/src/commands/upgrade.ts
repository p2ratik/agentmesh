import { VERSION } from '@agentmesh/common';
import { parseCommandArgs, usageError } from '../args';
import type { Command } from '../context';
import { deployWorkspace, isImageVersion } from '../setup/deploy';
import { readEnvFile, updateEnvFile } from '../setup/env-file';
import { loadAnswers, workspaceFrom } from '../setup/workspace';

export const upgradeCommand: Command = {
  name: 'upgrade',
  summary: 'Move the workspace to another hub version and deploy it',
  help: `Usage: agentmesh upgrade --dir <workspace> [--to <version>]

Sets AGENTMESH_VERSION in deploy/.env to --to (default: this CLI's version, ${VERSION}),
then runs setup deploy. If the deploy fails, the old version goes back into deploy/.env.
Nothing else changes the hub version a workspace runs.`,
  async run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { dir: { type: 'string' }, to: { type: 'string' } },
      { min: 0, max: 0, names: '' },
    );
    const to = values.to ?? VERSION;
    if (!isImageVersion(to)) throw usageError('--to takes an image version such as 0.4.0');
    const p = workspaceFrom(ctx, values.dir);
    const answers = loadAnswers(p);
    const previous = readEnvFile(p.envFile).get('AGENTMESH_VERSION') ?? '';
    // Printed, so never the value of a broken line (the token pasted there): upgrade fixes it.
    const from = !previous ? '(none)' : isImageVersion(previous) ? previous : '(not a version)';
    updateEnvFile(p.envFile, { AGENTMESH_VERSION: to });
    ctx.stdout(`Hub version ${from} → ${to}`);
    try {
      await deployWorkspace(ctx, p, answers);
    } catch (error) {
      // A version that is not published must not break every later config-only deploy.
      updateEnvFile(p.envFile, { AGENTMESH_VERSION: previous });
      ctx.stderr(`AGENTMESH_VERSION is back at ${from} in deploy/.env.`);
      throw error;
    }
    return 0;
  },
};
