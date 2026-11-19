// upgrade moves the image pin, then runs setup deploy.
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

  it('refuses a version that is not an image tag', async () => {
    const t = await workspace(serverAnswers(), ['discord', 'host']);
    expect(await t.run('upgrade', '--dir', t.p.root, '--to', '1.0 && rm -rf /')).toBe(2);
    expect(readEnvFile(t.p.envFile).get('COSMICWAVE_VERSION')).toBe(VERSION);
    expect(t.calls).toEqual([]);
  });
});
