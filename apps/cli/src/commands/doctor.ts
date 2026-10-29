import { parseCommandArgs } from '../args';
import type { CliContext, Command } from '../context';
import { loadTopology } from '../lib/config-files';
import { runProcess } from '../lib/process';
import { agentIdOf, type Hosting } from '../setup/answers';
import { checkAgentConnects } from '../setup/checks/agent';
import { classifyContainers } from '../setup/checks/containers';
import { checkDiscord } from '../setup/checks/discord';
import { checkDns, lookupAddresses } from '../setup/checks/dns';
import { checkNatsTls } from '../setup/checks/nats-tls';
import type { CheckResult } from '../setup/checks/result';
import { NATS_PORT } from '../setup/defaults';
import { readEnvFile } from '../setup/env-file';
import { runChecked, SSH_OPTIONS, sshProgram } from '../setup/remote';
import { renderChecklist } from '../setup/render/checklist';
import { agentSeedFile, loadAnswers, workspaceFrom } from '../setup/workspace';

const PS = ['compose', '--profile', 'discord', 'ps', '--format', 'json'];

/** `docker compose ps` here on a trial, or over ssh on the server; a failed run is a ✗ line. */
async function checkContainers(
  ctx: CliContext,
  hosting: Hosting,
  deployDir: string,
): Promise<CheckResult[]> {
  const run = ctx.run ?? runProcess;
  try {
    const { stdout } =
      hosting.mode === 'trial'
        ? await runChecked(run, 'docker', PS, { cwd: deployDir }, 'docker compose ps')
        : await runChecked(
            run,
            sshProgram('ssh', ctx),
            [
              ...SSH_OPTIONS,
              '--',
              hosting.ssh,
              `cd ${hosting.remoteDir}/deploy && docker ${PS.join(' ')}`,
            ],
            undefined,
            'docker compose ps on the server',
          );
    return classifyContainers(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [{ ok: false, label: 'Could not list the containers', detail }];
  }
}

export const doctorCommand: Command = {
  name: 'doctor',
  summary: "Check the mesh: DNS, TLS, containers, Discord channels and your agent's key",
  help: `Usage: agentmesh doctor --dir <workspace>

Checks that hosting.publicHost resolves and that NATS answers TLS there with a
certificate valid for at least 14 more days (a server only), that nats, hub and
discord-bridge are running and the hub healthy (\`docker compose ps\`, over ssh on a
server), that the Discord server has the category and channels the config names
(with the bot token from deploy/.env, never printed), and that your agent's key
connects. Prints ✓ or ✗ per check, and for a ✗ what to do. Exits 1 if any check
fails. It changes nothing.`,
  async run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { dir: { type: 'string' } },
      { min: 0, max: 0, names: '' },
    );
    const p = workspaceFrom(ctx, values.dir);
    const { team, admin, hosting } = loadAnswers(p);
    const env = readEnvFile(p.envFile);
    const { config } = loadTopology(p.configDir, Object.fromEntries(env));
    const results: CheckResult[] = [];

    if (hosting.mode === 'server') {
      results.push(await checkDns(hosting.publicHost, ctx.lookup ?? lookupAddresses));
      const probe = ctx.probeNatsTls ?? checkNatsTls;
      results.push(await probe(hosting.publicHost, NATS_PORT, new Date()));
    }
    results.push(...(await checkContainers(ctx, hosting, p.deployDir)));
    results.push(
      await checkDiscord(
        env.get('DISCORD_BOT_TOKEN') ?? '',
        env.get('DISCORD_GUILD_ID') ?? '',
        config.discord,
        ctx.fetch ?? fetch,
      ),
    );
    const agentId = agentIdOf(admin.id);
    const seedFile = agentSeedFile(ctx.homeDir, team.meshName, agentId);
    const natsUrl = config.nats.servers[0] ?? '';
    results.push(await checkAgentConnects(natsUrl, seedFile, agentId, ctx.connectNats));

    ctx.stdout(renderChecklist(team.name, results));
    return results.every((r) => r.ok) ? 0 : 1;
  },
};
