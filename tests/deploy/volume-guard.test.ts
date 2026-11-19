import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOLUME_GUARD } from '../../apps/cli/src/setup/deploy';

// The volume guard: a server that ran before the rename keeps its data in agentmesh_hub-data, and
// the compose file now says `name: cosmicwave`. docker, flock and sleep are stubs that log every
// docker call, so a test can tell that nothing was pulled or started.
const SCRIPT = 'deploy/auto-deploy/cosmicwave-deploy.sh';
const hasBash =
  spawnSync('bash', ['-c', '[ "$PROBE" = 1 ]'], { env: { ...process.env, PROBE: '1' } }).status ===
  0;

const posix = (p: string) =>
  p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replaceAll('\\', '/');
const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o755 });
};
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

// What docker compose resolves: COMPOSE_PROJECT_NAME, else the `name:` of the file it is given.
const PROJECT_NAME = `n=$(sed -n 's/^name: //p' | head -n 1); echo "name: \${COMPOSE_PROJECT_NAME:-$n}"`;

/**
 * Deploys v1.0.0 over a checkout that is still on v0.9.0 (compose name `agentmesh`). The stub
 * derives the project name from the compose file it is handed, so a guard that reads the wrong
 * file gives the wrong answer.
 */
function deployOver(o: { volume: 'exists' | 'none'; newName: string; projectEnv?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'cosmicwave-guard-'));
  try {
    const origin = join(root, 'origin');
    const compose = join(origin, 'deploy/docker-compose.yml');
    write(compose, 'name: agentmesh\nservices: {}\n');
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'old');
    git(origin, 'tag', 'v0.9.0');
    write(compose, `${o.newName ? `name: ${o.newName}\n` : ''}services: {}\n`);
    git(origin, 'commit', '-qam', 'new');
    git(origin, 'tag', 'v1.0.0');
    const checkout = join(root, 'cosmicwave');
    git(root, 'clone', '-q', origin, checkout);
    git(checkout, 'checkout', '-q', '--detach', 'v0.9.0');

    const bin = join(root, 'bin');
    const log = join(root, 'docker.log');
    write(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
echo "$*" >>"$DOCKER_LOG"
case "$*" in
  'volume inspect agentmesh_hub-data') [ "$VOLUME" = exists ] ;;
  'compose -f - config') ${PROJECT_NAME} ;;
  'compose config') { ${PROJECT_NAME}; } <docker-compose.yml ;;
  'compose ps -a -q hub') ;;
  'compose ps -q '*) echo c1 ;;
  inspect*) echo 'running 0' ;;
  'compose exec '*) echo '{"ok":true}' ;;
esac
`,
    );
    write(join(bin, 'flock'), '#!/bin/sh\n');
    write(join(bin, 'sleep'), '#!/bin/sh\n');
    const r = spawnSync('bash', [SCRIPT, 'deploy', '1.0.0'], {
      encoding: 'utf8',
      env: {
        PATH: `${posix(bin)}:${process.env.PATH}`,
        HOME: posix(root),
        COSMICWAVE_DIR: posix(checkout),
        DOCKER_LOG: posix(log),
        VOLUME: o.volume,
        ...(o.projectEnv ? { COMPOSE_PROJECT_NAME: o.projectEnv } : {}),
      },
    });
    const calls = readFileSync(log, 'utf8').split('\n');
    return { r, calls, out: r.stdout + r.stderr, now: git(checkout, 'describe', '--tags') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const started = (calls: string[]) =>
  calls.some((c) => c.startsWith('pull') || c.startsWith('compose up'));

describe.skipIf(!hasBash)('cosmicwave-deploy volume guard', () => {
  it('refuses to deploy a cosmicwave release over agentmesh volumes without the project name', () => {
    const { r, calls, out, now } = deployOver({ volume: 'exists', newName: 'cosmicwave' });
    expect(r.status).toBe(1);
    expect(out).toContain('COMPOSE_PROJECT_NAME=agentmesh');
    expect(out).toContain('Nothing was started.');
    expect(started(calls)).toBe(false);
    expect(calls.some((c) => /volume (create|rm|prune)/.test(c))).toBe(false);
    expect(now).toBe('v0.9.0'); // not checked out
  });

  it('refuses when compose cannot say the project name', () => {
    const { r, calls, now } = deployOver({ volume: 'exists', newName: '' });
    expect(r.status).toBe(1);
    expect(started(calls)).toBe(false);
    expect(now).toBe('v0.9.0');
  });

  it('deploys when COMPOSE_PROJECT_NAME=agentmesh is set', () => {
    const { r, calls, out, now } = deployOver({
      volume: 'exists',
      newName: 'cosmicwave',
      projectEnv: 'agentmesh',
    });
    expect(r.status, out).toBe(0);
    expect(calls.some((c) => c.startsWith('compose up'))).toBe(true);
    expect(now).toBe('v1.0.0');
  });

  it('deploys on a server with no agentmesh volumes', () => {
    const { r, calls, out } = deployOver({ volume: 'none', newName: 'cosmicwave' });
    expect(r.status, out).toBe(0);
    expect(calls.some((c) => c.startsWith('compose up'))).toBe(true);
  });
});

// The CLI sends VOLUME_GUARD over ssh; run it as a remote shell would.
function runGuard(volume: 'exists' | 'none', name: string) {
  const root = mkdtempSync(join(tmpdir(), 'cosmicwave-vg-'));
  try {
    write(
      join(root, 'docker'),
      `#!/usr/bin/env bash
case "$*" in
  'volume inspect agentmesh_hub-data') [ "$VOLUME" = exists ] ;;
  'compose config') echo "name: $NAME" ;;
esac
`,
    );
    const r = spawnSync('sh', ['-c', `${VOLUME_GUARD}; echo passed`], {
      encoding: 'utf8',
      env: { PATH: `${posix(root)}:${process.env.PATH}`, VOLUME: volume, NAME: name },
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!hasBash)('VOLUME_GUARD run by a shell', () => {
  it('refuses on agentmesh volumes under another project name', () => {
    const r = runGuard('exists', 'cosmicwave');
    expect(r.status).toBe(1);
    expect(r.err).toContain('COMPOSE_PROJECT_NAME=agentmesh');
    expect(r.out).not.toContain('passed');
  });
  it('refuses when the project name is empty', () => {
    expect(runGuard('exists', '').status).toBe(1);
  });
  it('passes with the project name agentmesh', () => {
    expect(runGuard('exists', 'agentmesh').out).toContain('passed');
  });
  it('passes with no agentmesh volume', () => {
    expect(runGuard('none', 'cosmicwave').out).toContain('passed');
  });
});
