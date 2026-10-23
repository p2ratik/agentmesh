import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import { loadConfig } from '@agentmesh/config';
import type { CliContext } from '../context';
import { runProcess } from '../lib/process';
import type { SetupAnswers } from './answers';
import { readEnvFile } from './env-file';
import { runChecked, SSH_OPTIONS } from './remote';
import { markDone, readState, type StepName, type WorkspacePaths } from './workspace';

/**
 * What `setup deploy` runs on the server before and after copying. `prepare` takes back
 * the seeds a previous deploy gave to uid 1000, so scp can replace them, and closes
 * `deploy/` to everyone but the ssh user: scp may create `.env` and the seeds readable by
 * all (Windows scp picks the mode), and only `finish` tightens them. `dir` is a validated
 * `hosting.remoteDir` (no spaces or shell characters), so it needs no quoting.
 */
export function remoteCommands(dir: string): { prepare: string; finish: string } {
  const seeds = `${dir}/deploy/secrets/*.nk`;
  return {
    prepare:
      `sudo chown -R "$(id -u):$(id -g)" ${dir}/deploy/secrets && ` +
      `mkdir -p ${dir}/deploy/secrets ${dir}/deploy/nats ${dir}/config && chmod 700 ${dir}/deploy`,
    finish:
      `chmod 600 ${dir}/deploy/.env && sudo chown 1000:1000 ${seeds} && sudo chmod 600 ${seeds} && ` +
      `cd ${dir}/deploy && docker compose --profile discord pull && docker compose --profile discord up -d`,
  };
}

/** The steps a deploy needs first: the Discord values, and on a server a prepared host. */
function requireDone(p: WorkspacePaths, steps: StepName[]): void {
  const { done } = readState(p);
  const missing = steps.find((step) => !done[step]);
  if (missing) throw new MeshError('invalid_transition', `Run setup ${missing} first.`);
}

/**
 * The seeds compose mounts, plus the auth-callout keys on a server. Checked before any copy:
 * a missing bridge seed would make Docker create a root-owned directory in its place.
 */
function requireSeeds(p: WorkspacePaths, mode: SetupAnswers['hosting']['mode']): void {
  const seeds = ['hub.nk', 'discord-bridge.nk'];
  if (mode === 'server') seeds.push('hub-issuer.nk', 'hub-xkey.nk', 'hub-sys.nk');
  const missing = seeds.find((name) => !existsSync(join(p.secretsDir, name)));
  if (missing) {
    throw new MeshError('not_found', `Missing deploy/secrets/${missing}; run setup render again.`);
  }
}

/** Runs a step that pulls the images; its failure gains a line naming the image. */
async function pulling(hint: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (!(error instanceof MeshError)) throw error;
    throw new MeshError(error.code, `${error.message}\n${hint}`);
  }
}

/**
 * Checks the config with the real `.env` values, then starts the stack: on a server it
 * copies the workspace over scp (run in the workspace with relative paths, so a drive
 * letter is never read as a host) and runs compose there; on a trial it runs compose here.
 */
export async function deployWorkspace(
  ctx: CliContext,
  p: WorkspacePaths,
  a: SetupAnswers,
): Promise<void> {
  const { hosting } = a;
  requireDone(p, hosting.mode === 'server' ? ['discord', 'host'] : ['discord']);
  const env = readEnvFile(p.envFile);
  // No stand-ins: an empty token, application id or server id fails here, before any copy.
  loadConfig(p.meshFile, { env: Object.fromEntries(env) });
  requireSeeds(p, hosting.mode);
  // Not secrets, so a failed pull can print them.
  const registry = env.get('AGENTMESH_IMAGE_REGISTRY') ?? '';
  const version = env.get('AGENTMESH_VERSION') ?? '';
  const image = `${registry}/agentmesh-hub:${version}`;
  const hint = `Check that ${image} exists (AGENTMESH_IMAGE_REGISTRY=${registry}, AGENTMESH_VERSION=${version}).`;
  const run = ctx.run ?? runProcess;

  if (hosting.mode === 'trial') {
    const compose = (args: string[], what: string) =>
      runChecked(
        run,
        'docker',
        ['compose', '--profile', 'discord', ...args],
        { cwd: p.deployDir },
        what,
      );
    await pulling(hint, () => compose(['pull'], 'Pulling the images'));
    await compose(['up', '-d'], 'Starting the stack');
    markDone(p, 'deploy', new Date());
    ctx.stdout(`Deployed ${image} on this machine.`);
    return;
  }

  const { ssh: target, remoteDir: dir } = hosting;
  const { prepare, finish } = remoteCommands(dir);
  const ssh = (command: string, what: string) =>
    runChecked(run, 'ssh', [...SSH_OPTIONS, '--', target, command], undefined, what);
  const scp = (flags: string[], sources: string[], to: string) =>
    runChecked(
      run,
      'scp',
      [...SSH_OPTIONS, ...flags, '--', ...sources, `${target}:${dir}/${to}`],
      { cwd: p.root },
      `Copying to ${dir}/${to}`,
    );
  const seeds = readdirSync(p.secretsDir)
    .filter((name) => name.endsWith('.nk'))
    .sort()
    .map((name) => `deploy/secrets/${name}`);

  await ssh(prepare, 'Preparing the server folders');
  await scp(['-q', '-r'], ['config'], '');
  await scp(['-q'], ['deploy/docker-compose.yml', 'deploy/.env'], 'deploy/');
  await scp(['-q'], ['deploy/nats/nats.conf'], 'deploy/nats/');
  // The bridge mounts its own seed file, so the seeds land before compose up.
  await scp(['-q'], seeds, 'deploy/secrets/');
  await pulling(hint, () => ssh(finish, 'Starting the stack on the server'));
  markDone(p, 'deploy', new Date());
  ctx.stdout(`Deployed ${image} to ${hosting.publicHost}.`);
}
