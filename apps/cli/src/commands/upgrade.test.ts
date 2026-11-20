// upgrade moves the image pin, then runs setup deploy.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '@cosmicwave/common';
import { describe, expect, it } from 'vitest';
import { remoteCommands } from '../setup/deploy';
import { readEnvFile } from '../setup/env-file';
import { serverAnswers } from '../setup/testing';
import { readState } from '../setup/workspace';
import { workspace } from './setup/deploy.fixture';

const { finish } = remoteCommands('/opt/cosmicwave');

describe('upgrade', () => {
  it('upgrade moves the pin and deploys', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    expect(await t.run('upgrade', '--dir', t.p.root, '--to', '0.9.0')).toBe(0);
    expect(readEnvFile(t.p.envFile).get('COSMICWAVE_VERSION')).toBe('0.9.0');
    expect(t.out).toEqual([
      `Hub version ${VERSION} → 0.9.0`,
      'Deployed ghcr.io/p2ratik/cosmicwave-hub:0.9.0 to mesh.acme.dev.',
    ]);
    expect(t.calls.map((c) => c.cmd)).toEqual(['ssh', 'scp', 'scp', 'scp', 'scp', 'ssh']);
    expect(readState(t.p).done.deploy).toBeDefined();
  });

  it('a failed deploy puts the old version back', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    t.failWhen((call) => call.args.includes(finish));
    expect(await t.run('upgrade', '--dir', t.p.root, '--to', '0.9.1')).toBe(1);
    expect(readEnvFile(t.p.envFile).get('COSMICWAVE_VERSION')).toBe(VERSION);
    expect(t.err[0]).toBe(`COSMICWAVE_VERSION is back at ${VERSION} in deploy/.env.`);
    expect(readState(t.p).done.deploy).toBeUndefined();
  });

  it('converts a workspace made as AgentMesh, then moves its pin to this version', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    // The workspace as 0.7.2 left it: the old keys, state file and compose file.
    const env = readFileSync(t.p.envFile, 'utf8').replaceAll('COSMICWAVE_', 'AGENTMESH_');
    writeFileSync(t.p.envFile, env.replace(/^AGENTMESH_VERSION=.*$/m, 'AGENTMESH_VERSION=0.7.2'));
    renameSync(t.p.state, join(t.p.root, '.agentmesh-setup.json'));
    writeFileSync(t.p.compose, 'name: agentmesh\n');
    expect(await t.run('upgrade', '--dir', t.p.root)).toBe(0);
    expect(t.out).toEqual([
      'Set hosting.remoteDir in setup-answers.json to the server folder it already uses',
      'Rendered deploy/docker-compose.yml again; the old one is kept as deploy/docker-compose.agentmesh.yml',
      'Added COSMICWAVE_CONFIG_DIR, COSMICWAVE_LOG_LEVEL, COSMICWAVE_IMAGE_REGISTRY, COMPOSE_PROJECT_NAME to deploy/.env',
      'Added COSMICWAVE_VERSION to deploy/.env',
      'Renamed .agentmesh-setup.json to .cosmicwave-setup.json',
      `Hub version 0.7.2 → ${VERSION}`,
      `Deployed ghcr.io/p2ratik/cosmicwave-hub:${VERSION} to mesh.acme.dev.`,
    ]);
    const after = readEnvFile(t.p.envFile);
    expect(after.get('COSMICWAVE_VERSION')).toBe(VERSION);
    expect(after.get('AGENTMESH_VERSION')).toBe('0.7.2');
    expect(after.get('COMPOSE_PROJECT_NAME')).toBe('agentmesh');
    // It deployed to the folder the server already uses, and recorded it.
    expect(t.calls.at(-1)?.args).toContain(remoteCommands('/opt/agentmesh').finish);
    expect(readState(t.p).done.deploy).toBeDefined();
  });

  it('refuses a version that is not an image tag', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    expect(await t.run('upgrade', '--dir', t.p.root, '--to', '1.0 && rm -rf /')).toBe(2);
    expect(readEnvFile(t.p.envFile).get('COSMICWAVE_VERSION')).toBe(VERSION);
    expect(t.calls).toEqual([]);
  });
});
