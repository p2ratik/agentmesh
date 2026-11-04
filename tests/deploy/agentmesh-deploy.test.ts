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

/** Runs the script as sshd would, against a checkout that does not exist. */
function forced(command: string) {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '/tmp',
      SSH_ORIGINAL_COMMAND: command,
      AGENTMESH_DIR: '/nonexistent/agentmesh',
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

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
  ])('refuses %j before touching anything', (command) => {
    const r = forced(command);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('refused');
    expect(r.stderr).not.toContain('nonexistent');
  });

  it.each(['deploy 0.5.1', 'deploy 10.20.30', 'deploy 1.0.0-rc.1', 'status'])(
    'accepts %j and goes on to look for the checkout',
    (command) => {
      const r = forced(command);
      expect(r.status).toBe(1);
      expect(r.stderr).not.toContain('refused');
      expect(r.stderr).toContain('/nonexistent/agentmesh/deploy/docker-compose.yml');
    },
  );

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
