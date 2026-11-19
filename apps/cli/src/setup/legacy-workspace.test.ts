import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEnvFile } from './env-file';
import { convertLegacyWorkspace } from './legacy-workspace';
import { serverAnswers, trialAnswers } from './testing';

const TOKEN = 'fake-token-for-this-test-only';

function legacy(opts: { env?: string; answers?: unknown; state?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cosmicwave-legacy-'));
  mkdirSync(join(root, 'deploy'));
  const env = join(root, 'deploy', '.env');
  writeFileSync(
    env,
    opts.env ??
      `DISCORD_BOT_TOKEN=${TOKEN}\nAGENTMESH_VERSION=0.7.2\nAGENTMESH_CONFIG_DIR=../config\n` +
        'AGENTMESH_IMAGE_REGISTRY=ghcr.io/p2ratik\nAGENTMESH_LOG_LEVEL=info\n',
  );
  writeFileSync(join(root, 'deploy', 'docker-compose.yml'), 'name: agentmesh\n');
  writeFileSync(
    join(root, 'setup-answers.json'),
    `${JSON.stringify(opts.answers ?? serverAnswers(), null, 2)}\n`,
  );
  if (opts.state !== false) {
    writeFileSync(
      join(root, '.agentmesh-setup.json'),
      JSON.stringify({ version: 1, done: { render: '2026-11-01T00:00:00.000Z' } }),
    );
  }
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  return { root, env, read };
}

describe('convertLegacyWorkspace', () => {
  it('does nothing to a workspace made after the rename', () => {
    const w = legacy({ env: 'COSMICWAVE_VERSION=0.8.0\n', state: false });
    expect(convertLegacyWorkspace(w.root)).toEqual([]);
    expect(w.read('deploy/docker-compose.yml')).toBe('name: agentmesh\n');
  });

  it('renames the state file and keeps the finished steps', () => {
    const w = legacy();
    convertLegacyWorkspace(w.root);
    expect(JSON.parse(w.read('.cosmicwave-setup.json')).done.render).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(() => w.read('.agentmesh-setup.json')).toThrow();
  });

  it('never renames over an existing state file', () => {
    const w = legacy();
    writeFileSync(join(w.root, '.cosmicwave-setup.json'), '{"version":1,"done":{}}');
    convertLegacyWorkspace(w.root);
    expect(w.read('.cosmicwave-setup.json')).toBe('{"version":1,"done":{}}');
  });

  it('adds the COSMICWAVE_ keys beside the old ones', () => {
    const w = legacy();
    convertLegacyWorkspace(w.root);
    const env = readEnvFile(w.env);
    expect(env.get('COSMICWAVE_VERSION')).toBe('0.7.2');
    expect(env.get('COSMICWAVE_CONFIG_DIR')).toBe('../config');
    expect(env.get('COSMICWAVE_IMAGE_REGISTRY')).toBe('ghcr.io/p2ratik');
    expect(env.get('COSMICWAVE_LOG_LEVEL')).toBe('info');
    expect(env.get('AGENTMESH_VERSION')).toBe('0.7.2');
    expect(env.get('DISCORD_BOT_TOKEN')).toBe(TOKEN);
  });

  it('sets COMPOSE_PROJECT_NAME=agentmesh', () => {
    const w = legacy();
    convertLegacyWorkspace(w.root);
    expect(readEnvFile(w.env).get('COMPOSE_PROJECT_NAME')).toBe('agentmesh');
  });

  it('keeps a COMPOSE_PROJECT_NAME the admin already set', () => {
    const w = legacy({ env: 'AGENTMESH_VERSION=0.7.2\nCOMPOSE_PROJECT_NAME=mine\n' });
    convertLegacyWorkspace(w.root);
    expect(readEnvFile(w.env).get('COMPOSE_PROJECT_NAME')).toBe('mine');
  });

  it('pins remoteDir to /opt/agentmesh for a server without one', () => {
    const w = legacy();
    convertLegacyWorkspace(w.root);
    const answers = JSON.parse(w.read('setup-answers.json'));
    expect(answers.hosting.remoteDir).toBe('/opt/agentmesh');
    expect(w.read('setup-answers.json')).toMatch(/\n {2}"hosting": \{/);
  });

  it('leaves a remoteDir the admin chose, and a trial, alone', () => {
    const base = serverAnswers();
    const chosen = { ...base, hosting: { ...base.hosting, remoteDir: '/srv/mesh' } };
    const a = legacy({ answers: chosen });
    convertLegacyWorkspace(a.root);
    expect(JSON.parse(a.read('setup-answers.json')).hosting.remoteDir).toBe('/srv/mesh');
    const b = legacy({ answers: trialAnswers() });
    convertLegacyWorkspace(b.root);
    expect(JSON.parse(b.read('setup-answers.json')).hosting.remoteDir).toBeUndefined();
  });

  it('renders the compose file again', () => {
    const w = legacy();
    convertLegacyWorkspace(w.root);
    expect(w.read('deploy/docker-compose.yml')).toContain('name: cosmicwave');
  });

  it('is a no-op the second time', () => {
    const w = legacy();
    expect(convertLegacyWorkspace(w.root).length).toBeGreaterThan(0);
    expect(convertLegacyWorkspace(w.root)).toEqual([]);
  });

  it('never prints a value from .env', () => {
    const w = legacy();
    const lines = convertLegacyWorkspace(w.root);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('0.7.2');
      expect(line).not.toContain('ghcr.io');
    }
  });
});
