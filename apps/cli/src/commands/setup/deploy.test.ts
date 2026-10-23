import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { VERSION } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../context';
import { runCli } from '../../main';
import { remoteCommands } from '../../setup/deploy';
import { readEnvFile, updateEnvFile } from '../../setup/env-file';
import { type AnswersInput, serverAnswers, trialAnswers } from '../../setup/testing';
import { markDone, readState, type StepName, workspacePaths } from '../../setup/workspace';

const TOKEN = 'tok-SECRET-123';
const TARGET = 'deploy@mesh.acme.dev';
const SSH = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
const { prepare, finish } = remoteCommands('/opt/agentmesh');

interface Call {
  cmd: string;
  args: readonly string[];
  cwd?: string;
}

/**
 * A rendered workspace in a folder whose name has a space, with the Discord values in .env
 * and the `done` steps recorded. The fake `run` records each call and fails those `fails` picks.
 */
async function workspace(answers: AnswersInput, done: StepName[], token = TOKEN) {
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-setup-deploy-'));
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  let fails = (_call: Call) => false;
  const ctx: CliContext = {
    cwd,
    env: {},
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    run: async (cmd, args, opts) => {
      const call = { cmd, args, cwd: opts?.cwd };
      calls.push(call);
      return fails(call)
        ? { code: 1, stdout: '', stderr: 'manifest unknown' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  const run = (...argv: string[]) => runCli(argv, ctx);
  const p = workspacePaths(join(cwd, 'First Last', 'acme'));
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.answers, JSON.stringify(answers));
  expect(await run('setup', 'render', '--dir', p.root)).toBe(0);
  out.length = 0;
  updateEnvFile(p.envFile, {
    DISCORD_BOT_TOKEN: token,
    DISCORD_APP_ID: '100000000000000001',
    DISCORD_GUILD_ID: '200000000000000002',
  });
  for (const step of done) markDone(p, step, new Date());
  return {
    p,
    out,
    err,
    calls,
    run,
    deploy: () => run('setup', 'deploy', '--dir', p.root),
    failWhen: (pick: (call: Call) => boolean) => {
      fails = pick;
    },
  };
}

describe('setup deploy', () => {
  it('runs these commands on the server', () => {
    expect(prepare).toBe(
      'sudo chown -R "$(id -u):$(id -g)" /opt/agentmesh/deploy/secrets && mkdir -p /opt/agentmesh/deploy/secrets /opt/agentmesh/deploy/nats /opt/agentmesh/config',
    );
    expect(finish).toBe(
      'chmod 600 /opt/agentmesh/deploy/.env && sudo chown 1000:1000 /opt/agentmesh/deploy/secrets/*.nk && sudo chmod 600 /opt/agentmesh/deploy/secrets/*.nk && cd /opt/agentmesh/deploy && docker compose --profile discord pull && docker compose --profile discord up -d',
    );
  });

  it('server deploy runs prepare, the copies, then finish', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    expect(await t.deploy()).toBe(0);
    expect(t.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['ssh', ...SSH, '--', TARGET, prepare],
      ['scp', ...SSH, '-q', '-r', '--', 'config', `${TARGET}:/opt/agentmesh/`],
      [
        'scp',
        ...SSH,
        '-q',
        '--',
        'deploy/docker-compose.yml',
        'deploy/.env',
        `${TARGET}:/opt/agentmesh/deploy/`,
      ],
      ['scp', ...SSH, '-q', '--', 'deploy/nats/nats.conf', `${TARGET}:/opt/agentmesh/deploy/nats/`],
      [
        'scp',
        ...SSH,
        '-q',
        '--',
        'deploy/secrets/discord-bridge.nk',
        'deploy/secrets/hub-issuer.nk',
        'deploy/secrets/hub-sys.nk',
        'deploy/secrets/hub-xkey.nk',
        'deploy/secrets/hub.nk',
        `${TARGET}:/opt/agentmesh/deploy/secrets/`,
      ],
      ['ssh', ...SSH, '--', TARGET, finish],
    ]);
    expect(t.out).toEqual([`Deployed ghcr.io/p2ratik/agentmesh-hub:${VERSION} to mesh.acme.dev.`]);
    expect(readState(t.p).done.deploy).toBeDefined();
  });

  it('a workspace path with a space and a drive letter', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    expect(t.p.root).toContain('First Last');
    expect(await t.deploy()).toBe(0);
    const copies = t.calls.filter((c) => c.cmd === 'scp');
    expect(copies).toHaveLength(4);
    for (const call of copies) {
      expect(call.cwd).toBe(t.p.root);
      for (const arg of call.args.filter((a) => !a.startsWith(`${TARGET}:`))) {
        expect(isAbsolute(arg)).toBe(false);
        expect(arg).not.toMatch(/^[A-Za-z]:[\\/]/);
      }
    }
  });

  it('a failed pull is not marked done and names the image', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    t.failWhen((call) => call.args.includes(finish));
    expect(await t.deploy()).toBe(1);
    expect(readState(t.p).done.deploy).toBeUndefined();
    const message = t.err.join('\n');
    expect(message).toContain('manifest unknown');
    expect(message).toContain(
      `Check that ghcr.io/p2ratik/agentmesh-hub:${VERSION} exists ` +
        `(AGENTMESH_IMAGE_REGISTRY=ghcr.io/p2ratik, AGENTMESH_VERSION=${VERSION}).`,
    );
    expect(message).not.toContain('.env');
    expect([...t.out, ...t.err].join('\n')).not.toContain(TOKEN);

    t.failWhen(() => false);
    expect(await t.deploy()).toBe(0);
    expect(readState(t.p).done.deploy).toBeDefined();
  });

  it('an empty token fails before anything is copied', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host'], '');
    expect(await t.deploy()).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.err.join('\n')).toContain('discord.token');
    expect(readState(t.p).done.deploy).toBeUndefined();
  });

  it('trial deploy runs docker compose in deploy/', async () => {
    const t = await workspace(trialAnswers(), ['discord']);
    expect(await t.deploy()).toBe(0);
    expect(t.calls).toEqual([
      { cmd: 'docker', args: ['compose', '--profile', 'discord', 'pull'], cwd: t.p.deployDir },
      { cmd: 'docker', args: ['compose', '--profile', 'discord', 'up', '-d'], cwd: t.p.deployDir },
    ]);
    expect(t.out).toEqual([`Deployed ghcr.io/p2ratik/agentmesh-hub:${VERSION} on this machine.`]);
    expect(readState(t.p).done.deploy).toBeDefined();
  });

  it('refuses before discord is done', async () => {
    const trial = await workspace(trialAnswers(), []);
    expect(await trial.deploy()).toBe(1);
    expect(trial.err).toEqual(['error: Run setup discord first.']);
    expect(trial.calls).toEqual([]);

    const server = await workspace(serverAnswers(), ['discord']);
    expect(await server.deploy()).toBe(1);
    expect(server.err).toEqual(['error: Run setup host first.']);
    expect(server.calls).toEqual([]);
  });
});

describe('upgrade', () => {
  it('upgrade moves the pin and deploys', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    expect(await t.run('upgrade', '--dir', t.p.root, '--to', '0.9.0')).toBe(0);
    expect(readEnvFile(t.p.envFile).get('AGENTMESH_VERSION')).toBe('0.9.0');
    expect(t.out).toEqual([
      `Hub version ${VERSION} → 0.9.0`,
      'Deployed ghcr.io/p2ratik/agentmesh-hub:0.9.0 to mesh.acme.dev.',
    ]);
    expect(t.calls.map((c) => c.cmd)).toEqual(['ssh', 'scp', 'scp', 'scp', 'scp', 'ssh']);
    expect(readState(t.p).done.deploy).toBeDefined();
  });

  it('refuses a version that is not an image tag', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    expect(await t.run('upgrade', '--dir', t.p.root, '--to', '1.0 && rm -rf /')).toBe(2);
    expect(readEnvFile(t.p.envFile).get('AGENTMESH_VERSION')).toBe(VERSION);
    expect(t.calls).toEqual([]);
  });
});
