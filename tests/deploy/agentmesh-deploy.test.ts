import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The deploy key's forced command (docs/deploy.md#automatic-deploys): whatever the SSH client
// asks for arrives in SSH_ORIGINAL_COMMAND, and only two fixed shapes may pass.
const SCRIPT = 'deploy/auto-deploy/agentmesh-deploy.sh';
const SCRIPTS = [SCRIPT, 'deploy/auto-deploy/install.sh', 'deploy/azure/github-deploy-setup.sh'];
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

describe('deploy scripts', () => {
  // Bash reads an apostrophe in "${VAR:?message}" as a quote: one breaks the script, two silently
  // swallow the lines between them.
  it.each(SCRIPTS)('%s keeps apostrophes out of variable expansions', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text.match(/\$\{\w+:?[?=+-][^}]*'[^}]*\}/g) ?? []).toEqual([]);
  });
});
