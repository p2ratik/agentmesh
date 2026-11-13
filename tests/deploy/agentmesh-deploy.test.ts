import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The deploy key's forced command (docs/deploy.md#automatic-deploys): whatever the SSH client
// asks for arrives in SSH_ORIGINAL_COMMAND, and only two fixed shapes may pass.
const SCRIPT = 'deploy/auto-deploy/agentmesh-deploy.sh';
const SCRIPTS = [
  SCRIPT,
  'deploy/auto-deploy/install.sh',
  'deploy/auto-deploy/github-setup.sh',
  'deploy/azure/github-deploy-setup.sh',
  'deploy/aws/github-deploy-setup.sh',
];
// A bash that receives our environment (WSL's bash.exe on Windows does not pass it through).
const hasBash =
  spawnSync('bash', ['-c', '[ "$PROBE" = 1 ]'], { env: { ...process.env, PROBE: '1' } }).status ===
  0;

const HUB = `sha256:${'a1'.repeat(32)}`;
const BRIDGE = `sha256:${'b2'.repeat(32)}`;

/** Runs the script against a checkout that does not exist: as sshd would, or as an admin would. */
function run(how: { ssh: string } | { args: string[] }) {
  const result = spawnSync('bash', [SCRIPT, ...('args' in how ? how.args : [])], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '/tmp',
      ...('ssh' in how ? { SSH_ORIGINAL_COMMAND: how.ssh } : {}),
      AGENTMESH_DIR: '/nonexistent/agentmesh',
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const refused = (r: ReturnType<typeof run>) => {
  expect(r.status).toBe(2);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('refused');
  expect(r.stderr).not.toContain('nonexistent');
};
const accepted = (r: ReturnType<typeof run>) => {
  expect(r.status).toBe(1);
  expect(r.stderr).not.toContain('refused');
  expect(r.stderr).toContain('/nonexistent/agentmesh/deploy/docker-compose.yml');
};

describe.skipIf(!hasBash)('agentmesh-deploy forced command', () => {
  it.each([
    '',
    'bash',
    'sh -c id',
    'deploy',
    'deploy 1.2',
    'deploy v1.2.3',
    'deploy 1.2.3; id',
    'deploy 1.2.3 && id',
    'deploy $(id)',
    'deploy `id`',
    'deploy 1.2.3\nid',
    'deploy ../1.2.3',
    'deploy 1.2.3 --force',
    'deploy  1.2.3',
    'status; id',
    'status extra',
    'rollback 1.2.3',
    // Over SSH the images must be named by the digests the workflow verified.
    'deploy 0.5.1',
    `deploy 0.5.1 ${HUB}`,
    `deploy 0.5.1 ${HUB} ${BRIDGE} extra`,
    `deploy 0.5.1 ${HUB};id ${BRIDGE}`,
    `deploy 0.5.1 ${HUB.toUpperCase()} ${BRIDGE}`,
    `deploy 0.5.1 ${HUB.slice(0, -1)} ${BRIDGE}`,
    `deploy 0.5.1 ${HUB.replace('sha256', 'sha512')} ${BRIDGE}`,
    `deploy 0.5.1 ghcr.io/evil/hub@${HUB} ${BRIDGE}`,
  ])('refuses %j before touching anything', (command) => {
    refused(run({ ssh: command }));
  });

  it.each([`deploy 0.5.1 ${HUB} ${BRIDGE}`, `deploy 1.0.0-rc.1 ${HUB} ${BRIDGE}`, 'status'])(
    'accepts %j and goes on to look for the checkout',
    (command) => {
      accepted(run({ ssh: command }));
    },
  );

  it('lets an admin on the server deploy by version alone', () => {
    accepted(run({ args: ['deploy', '0.5.1'] }));
    accepted(run({ args: ['deploy', '0.5.1', HUB, BRIDGE] }));
    refused(run({ args: ['deploy', '0.5.1;', 'id'] }));
  });

  it.each(SCRIPTS)('%s parses', (file) => {
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

// A real deploy from tag v1.0.0 to v1.0.1, with docker faked: Linux only (flock, GNU tee).
const hasFlock = hasBash && spawnSync('bash', ['-c', 'command -v flock']).status === 0;

describe.skipIf(!hasFlock)('agentmesh-deploy over a checkout with hand edits', () => {
  it('saves the edits as a patch, deploys the release and keeps the live config', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentmesh-deploy-'));
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd,
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const write = (file: string, text: string) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, { mode: 0o755 });
    };
    try {
      const origin = join(root, 'origin');
      write(join(origin, '.gitignore'), '/config/*\n!/config/examples/\n');
      write(join(origin, 'deploy/docker-compose.yml'), 'services: {}\n');
      write(join(origin, 'config/examples/mesh.yaml'), 'one\n');
      git(origin, 'init', '-q', '-b', 'main');
      git(origin, 'add', '.');
      git(origin, 'commit', '-qm', 'one');
      git(origin, 'tag', 'v1.0.0');
      write(join(origin, 'config/examples/mesh.yaml'), 'two\n');
      git(origin, 'commit', '-qam', 'two');
      git(origin, 'tag', 'v1.0.1');

      const checkout = join(root, 'agentmesh');
      git(root, 'clone', '-q', origin, checkout);
      git(checkout, 'checkout', '-q', '--detach', 'v1.0.0');
      write(join(checkout, 'config/examples/mesh.yaml'), 'stale copy\n');
      write(join(checkout, 'config/mesh.yaml'), 'live\n');

      // A running, healthy stack with no hub container to back up yet; sleep returns at once.
      const bin = join(root, 'bin');
      write(
        join(bin, 'docker'),
        `#!/usr/bin/env bash
case "$*" in
  'compose ps -a -q hub') ;;
  'compose ps -q '*) echo c1 ;;
  inspect*) echo 'running 0' ;;
  'compose exec '*) echo '{"ok":true}' ;;
esac
`,
      );
      write(join(bin, 'sleep'), '#!/bin/sh\n');

      const r = spawnSync('bash', [SCRIPT, 'deploy', '1.0.1'], {
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, AGENTMESH_DIR: checkout },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(git(checkout, 'describe', '--tags')).toBe('v1.0.1');
      expect(readFileSync(join(checkout, 'config/examples/mesh.yaml'), 'utf8')).toBe('two\n');
      expect(readFileSync(join(checkout, 'config/mesh.yaml'), 'utf8')).toBe('live\n');
      expect(r.stdout).toContain('M config/examples/mesh.yaml');
      const state = join(root, '.local/state/agentmesh-deploy');
      const patches = readdirSync(state).filter((f) => f.startsWith('local-edits-'));
      expect(patches).toHaveLength(1);
      expect(readFileSync(join(state, patches[0] ?? ''), 'utf8')).toContain('+stale copy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('deploy scripts', () => {
  // Bash reads an apostrophe in "${VAR:?message}" as a quote: one breaks the script, two silently
  // swallow the lines between them.
  it.each(SCRIPTS)('%s keeps apostrophes out of variable expansions', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text.match(/\$\{\w+:?[?=+-][^}]*'[^}]*\}/g) ?? []).toEqual([]);
  });
});
