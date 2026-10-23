import { VERSION } from '@agentmesh/common';
import { parseCommandArgs, usageError } from '../args';
import type { Command } from '../context';
import { deployWorkspace } from '../setup/deploy';
import { readEnvFile, updateEnvFile } from '../setup/env-file';
import { loadAnswers, workspaceFrom } from '../setup/workspace';

/** A Docker image tag, which is what the version becomes in the image name. */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export const upgradeCommand: Command = {
  name: 'upgrade',
  summary: 'Move the workspace to another hub version and deploy it',
  help: `Usage: agentmesh upgrade --dir <workspace> [--to <version>]

Sets AGENTMESH_VERSION in deploy/.env to --to (default: this CLI's version, ${VERSION}),
then runs setup deploy. Nothing else changes the hub version a workspace runs.`,
  async run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { dir: { type: 'string' }, to: { type: 'string' } },
      { min: 0, max: 0, names: '' },
    );
    const to = values.to ?? VERSION;
    if (!IMAGE_TAG.test(to)) throw usageError('--to takes an image version such as 0.4.0');
    const p = workspaceFrom(ctx, values.dir);
    const answers = loadAnswers(p);
    const from = readEnvFile(p.envFile).get('AGENTMESH_VERSION') || '(none)';
    updateEnvFile(p.envFile, { AGENTMESH_VERSION: to });
    ctx.stdout(`Hub version ${from} → ${to}`);
    await deployWorkspace(ctx, p, answers);
    return 0;
  },
};
