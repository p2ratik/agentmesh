import { parseCommandArgs } from '../../args';
import type { Command } from '../../context';
import { deployWorkspace } from '../../setup/deploy';
import { loadAnswers, workspaceFrom } from '../../setup/workspace';

export const setupDeployCommand: Command = {
  name: 'setup deploy',
  summary: 'Copy the workspace to the server and start the hub (or start it here on a trial)',
  help: `Usage: agentmesh setup deploy --dir <workspace>

Checks the config with the workspace's real settings, then on a server copies config/,
deploy/docker-compose.yml, deploy/.env, deploy/nats/nats.conf and deploy/secrets/*.nk
to hosting.remoteDir over scp (with your own SSH key) and runs \`docker compose pull\`
and \`up -d --force-recreate\` there, so NATS, the hub and the bridge load what changed.
On a trial it runs them in deploy/. The hub version is the workspace's pin, which only
\`agentmesh upgrade\` moves. Safe to re-run.`,
  async run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { dir: { type: 'string' } },
      { min: 0, max: 0, names: '' },
    );
    const p = workspaceFrom(ctx, values.dir);
    await deployWorkspace(ctx, p, loadAnswers(p));
    return 0;
  },
};
