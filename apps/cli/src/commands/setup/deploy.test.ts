import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { VERSION } from '@cosmicwave/common';
import { describe, expect, it } from 'vitest';
import { remoteCommands, VOLUME_GUARD } from '../../setup/deploy';
import { readEnvFile, updateEnvFile } from '../../setup/env-file';
import { serverAnswers, trialAnswers } from '../../setup/testing';
import { readState } from '../../setup/workspace';
import { TOKEN, workspace } from './deploy.fixture';

// Discord-token-shaped and fake; built at runtime so secret scanners skip it.
const DISCORD_TOKEN = [`MTIz${'A'.repeat(22)}`, 'GaBcDe', 'F'.repeat(34)].join('.');
const TARGET = 'deploy@mesh.acme.dev';
const SSH = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ControlPath=none',
];
const { prepare, finish } = remoteCommands('/opt/cosmicwave');

describe('setup deploy', () => {
  // --force-recreate: config/, nats.conf and the seeds are bind mounts, so a plain `up -d`
  // keeps the old containers, and the old config and keys, after a change to them alone.
  // The [ -d ] guard: a server rebuilt under the same name has no folders, and chown would fail.
  // config.new, then a swap: scp -r merges into an existing folder, and the hub loads every
  // YAML file in the include folders, so a file deleted here would keep running there.
  it('runs these commands on the server', () => {
    expect(prepare).toBe(
      "[ -d /opt/cosmicwave/deploy/secrets ] || { echo 'Run setup host again: /opt/cosmicwave/deploy/secrets is missing on the server.' >&2; exit 1; }; " +
        'sudo chown -R "$(id -u):$(id -g)" /opt/cosmicwave/deploy/secrets && mkdir -p /opt/cosmicwave/deploy/secrets /opt/cosmicwave/deploy/nats && rm -rf /opt/cosmicwave/config.new && chmod 700 /opt/cosmicwave/deploy',
    );
    expect(finish).toBe(
      'rm -rf /opt/cosmicwave/config && mv /opt/cosmicwave/config.new /opt/cosmicwave/config && chmod 600 /opt/cosmicwave/deploy/.env && chmod 644 /opt/cosmicwave/deploy/nats/nats.conf && sudo chown 1000:1000 /opt/cosmicwave/deploy/secrets/*.nk && sudo chmod 600 /opt/cosmicwave/deploy/secrets/*.nk && cd /opt/cosmicwave/deploy && ' +
        `${VOLUME_GUARD} && docker compose --profile discord pull && docker compose --profile discord up -d --force-recreate`,
    );
  });

  // A server that ran before the rename keeps its data in agentmesh_* volumes: the guard must
  // refuse before anything is pulled or started.
  it('checks the volumes before pulling', () => {
    expect(VOLUME_GUARD).toContain('agentmesh_hub-data');
    expect(VOLUME_GUARD).toContain('COMPOSE_PROJECT_NAME=agentmesh');
    expect(finish).toContain(VOLUME_GUARD);
    expect(finish.indexOf(VOLUME_GUARD)).toBeGreaterThan(
      finish.indexOf('cd /opt/cosmicwave/deploy'),
    );
    expect(finish.indexOf(VOLUME_GUARD)).toBeLessThan(
      finish.indexOf('docker compose --profile discord pull'),
    );
  });

  it('has no apostrophe in the guard', () => {
    expect(VOLUME_GUARD).not.toContain("'");
  });

  it('server deploy runs prepare, the copies, then finish', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    expect(await t.deploy()).toBe(0);
    expect(t.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['ssh', ...SSH, '--', TARGET, prepare],
      ['scp', ...SSH, '-q', '-r', '--', 'config', `${TARGET}:/opt/cosmicwave/config.new`],
      [
        'scp',
        ...SSH,
        '-q',
        '--',
        'deploy/docker-compose.yml',
        'deploy/.env',
        `${TARGET}:/opt/cosmicwave/deploy/`,
      ],
      [
        'scp',
        ...SSH,
        '-q',
        '--',
        'deploy/nats/nats.conf',
        `${TARGET}:/opt/cosmicwave/deploy/nats/`,
      ],
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
        `${TARGET}:/opt/cosmicwave/deploy/secrets/`,
      ],
      ['ssh', ...SSH, '--', TARGET, finish],
    ]);
    expect(t.out).toEqual([`Deployed ghcr.io/p2ratik/cosmicwave-hub:${VERSION} to mesh.acme.dev.`]);
    expect(readState(t.p).done.deploy).toBeDefined();
  });

  it('a failed copy names the step, not the image, and is not marked done', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    // config/, .env and nats.conf have landed; the seeds copy fails last.
    t.failWhen((call) => call.args.includes('deploy/secrets/hub.nk'));
    expect(await t.deploy()).toBe(1);
    expect(readState(t.p).done.deploy).toBeUndefined();
    const message = t.err.join('\n');
    expect(message).toContain('Copying to /opt/cosmicwave/deploy/secrets/ failed');
    expect(message).not.toContain('Check that');
    expect(t.calls.some((c) => c.args.includes(finish))).toBe(false);

    t.failWhen(() => false);
    expect(await t.deploy()).toBe(0);
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
      `Check that ghcr.io/p2ratik/cosmicwave-hub:${VERSION} exists ` +
        `(COSMICWAVE_IMAGE_REGISTRY=ghcr.io/p2ratik, COSMICWAVE_VERSION=${VERSION}).`,
    );
    expect(message).not.toContain('.env');
    expect([...t.out, ...t.err].join('\n')).not.toContain(TOKEN);

    t.failWhen(() => false);
    expect(await t.deploy()).toBe(0);
    expect(readState(t.p).done.deploy).toBeDefined();
  });

  it('a token pasted on the image lines is refused before anything runs, never printed', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    for (const key of ['COSMICWAVE_VERSION', 'COSMICWAVE_IMAGE_REGISTRY']) {
      const kept = readEnvFile(t.p.envFile).get(key) ?? '';
      updateEnvFile(t.p.envFile, { [key]: DISCORD_TOKEN });
      expect(await t.deploy(), key).toBe(1);
      expect(t.err.at(-1)).toContain(`error: ${key} in deploy/.env is not an image`);
      updateEnvFile(t.p.envFile, { [key]: kept });
    }
    expect(t.calls).toEqual([]);
    expect([...t.out, ...t.err].join('\n')).not.toContain(DISCORD_TOKEN);
  });

  // A converted workspace keeps its 0.7.2 pin; no image of that version has the new names.
  it('refuses a version from before the new image names, before anything runs', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    for (const old of ['0.7.2', '0.7.2-rc.1']) {
      updateEnvFile(t.p.envFile, { COSMICWAVE_VERSION: old });
      expect(await t.deploy()).toBe(1);
      expect(t.err.at(-1)).toBe(
        `error: COSMICWAVE_VERSION in deploy/.env is ${old}, but images under the new names start at 0.8.0. Run \`cmw upgrade --dir <workspace>\` first: it moves the pin to ${VERSION} and deploys. Nothing was copied or started.`,
      );
    }
    expect(t.calls).toEqual([]);
    expect(readState(t.p).done.deploy).toBeUndefined();
    // A tag it cannot order (one an admin built and pushed) is left to the registry.
    updateEnvFile(t.p.envFile, { COSMICWAVE_VERSION: 'my-build' });
    expect(await t.deploy()).toBe(0);
  });

  it('on Windows, runs the system OpenSSH, which can use the Windows ssh-agent', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    const root = mkdtempSync(join(tmpdir(), 'cosmicwave-windows-'));
    const openssh = join(root, 'System32', 'OpenSSH');
    mkdirSync(openssh, { recursive: true });
    for (const exe of ['ssh.exe', 'scp.exe']) writeFileSync(join(openssh, exe), '');
    t.ctx.platform = 'win32';
    t.ctx.env.SystemRoot = root;
    expect(await t.deploy()).toBe(0);
    expect(t.calls.map((c) => c.cmd)).toEqual([
      join(openssh, 'ssh.exe'),
      ...Array(4).fill(join(openssh, 'scp.exe')),
      join(openssh, 'ssh.exe'),
    ]);
  });

  it('an empty token fails before anything is copied', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host'], '');
    expect(await t.deploy()).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.err.join('\n')).toContain('discord.token');
    expect(readState(t.p).done.deploy).toBeUndefined();
  });

  it('a missing seed fails before anything is run', async () => {
    const server = await workspace(serverAnswers(), ['discord', 'host']);
    rmSync(join(server.p.secretsDir, 'discord-bridge.nk'));
    expect(await server.deploy()).toBe(1);
    expect(server.calls).toEqual([]);
    expect(server.err).toEqual([
      'error: Missing deploy/secrets/discord-bridge.nk; run setup render again.',
    ]);
    expect(readState(server.p).done.deploy).toBeUndefined();

    const trial = await workspace(trialAnswers(), ['discord']);
    rmSync(join(trial.p.secretsDir, 'hub.nk'));
    expect(await trial.deploy()).toBe(1);
    expect(trial.calls).toEqual([]);
    expect(trial.err).toEqual(['error: Missing deploy/secrets/hub.nk; run setup render again.']);
  });

  it('trial deploy runs docker compose in deploy/', async () => {
    const t = await workspace(trialAnswers(), ['discord']);
    expect(await t.deploy()).toBe(0);
    expect(t.calls).toEqual([
      { cmd: 'docker', args: ['compose', '--profile', 'discord', 'pull'], cwd: t.p.deployDir },
      {
        cmd: 'docker',
        args: ['compose', '--profile', 'discord', 'up', '-d', '--force-recreate'],
        cwd: t.p.deployDir,
      },
    ]);
    expect(t.out).toEqual([`Deployed ghcr.io/p2ratik/cosmicwave-hub:${VERSION} on this machine.`]);
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
