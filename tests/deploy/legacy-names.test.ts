import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// deploy/legacy-names.sh: how the server installers take over an install made before the rename,
// when the scripts, units and keys were named agentmesh-*. Sourced in bash against temp files only.
const LIB = 'deploy/legacy-names.sh';
const hasBash =
  spawnSync('bash', ['-c', '[ "$PROBE" = 1 ]'], { env: { ...process.env, PROBE: '1' } }).status ===
  0;

const posix = (p: string) =>
  p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replaceAll('\\', '/');

let dir: string;
const at = (name: string) => join(dir, name);

/** Runs `script` in the temp folder (also $D) with bash, as `set -euo pipefail` installers do. */
function run(script: string) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . ${posix(resolve(LIB))}; ${script}`], {
    encoding: 'utf8',
    cwd: dir,
    env: { PATH: process.env.PATH, D: posix(dir) },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cosmicwave-legacy-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasBash)('legacy-names.sh', () => {
  it('carries the settings and renames the folder key', () => {
    const cases: [string, string][] = [
      [
        'AGENTMESH_DIR=/opt/agentmesh\n#GIT_REMOTE=origin\n',
        'COSMICWAVE_DIR=/opt/agentmesh\n#GIT_REMOTE=origin\n',
      ],
      ['#AGENTMESH_DIR=/opt/agentmesh\n', '#COSMICWAVE_DIR=/opt/agentmesh\n'],
    ];
    for (const [before, after] of cases) {
      writeFileSync(at('old'), before);
      rmSync(at('new'), { force: true });
      expect(run('carry_settings "$D/old" "$D/new"').status).toBe(0);
      expect(readFileSync(at('new'), 'utf8')).toBe(after);
      expect(existsSync(at('old'))).toBe(false);
      if (process.platform !== 'win32') expect(statSync(at('new')).mode & 0o777).toBe(0o644);
    }
    expect(readdirSync(dir)).toEqual(['new']);

    // A write that fails keeps the old file, and the installer stops.
    writeFileSync(at('old'), 'AGENTMESH_DIR=/opt/agentmesh\n');
    const failed = run('carry_settings "$D/old" "$D/no-such-folder/new"; echo went on');
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).not.toContain('went on');
    expect(existsSync(at('old'))).toBe(true);
  });

  it('keeps settings that already exist under the new name', () => {
    writeFileSync(at('old'), 'AGENTMESH_DIR=/opt/agentmesh\n');
    writeFileSync(at('new'), 'COSMICWAVE_DIR=/srv/mesh\n');
    expect(run('carry_settings "$D/old" "$D/new"').status).toBe(0);
    expect(readFileSync(at('new'), 'utf8')).toBe('COSMICWAVE_DIR=/srv/mesh\n');
    expect(existsSync(at('old'))).toBe(true);

    // Nothing to carry: nothing is written.
    rmSync(at('old'));
    rmSync(at('new'));
    expect(run('carry_settings "$D/old" "$D/new"').status).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('carries a folder only when the new one is missing', () => {
    mkdirSync(at('old'));
    writeFileSync(at('old/lock'), 'held');
    expect(run('carry_path "$D/old" "$D/new"').status).toBe(0);
    expect(readFileSync(at('new/lock'), 'utf8')).toBe('held');
    expect(existsSync(at('old'))).toBe(false);

    // Both exist: neither changes, and the old one is not moved inside the new one.
    mkdirSync(at('old'));
    writeFileSync(at('old/lock'), 'stale');
    expect(run('carry_path "$D/old" "$D/new"').status).toBe(0);
    expect(readdirSync(at('new'))).toEqual(['lock']);
    expect(readFileSync(at('new/lock'), 'utf8')).toBe('held');
    expect(readFileSync(at('old/lock'), 'utf8')).toBe('stale');

    expect(run('carry_path "$D/none" "$D/also-none"').status).toBe(0);
    expect(existsSync(at('also-none'))).toBe(false);
  });

  it('drops both deploy lines and keeps every other key byte for byte', () => {
    const admin = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIadmin pratik@laptop';
    const old =
      'restrict,command="/usr/local/sbin/agentmesh-deploy" ssh-ed25519 AAAAold agentmesh-github-deploy';
    const now =
      'restrict,command="/usr/local/sbin/cosmicwave-deploy" ssh-ed25519 AAAAnew cosmicwave-github-deploy';
    const comment = '# the admin, from home';
    const lookalike = 'from="10.0.0.0/8" ssh-ed25519 AAAAx my-agentmesh-github-deploy';
    const longer = 'ssh-ed25519 AAAAy cosmicwave-github-deploy (old laptop)';
    const spaced = 'ssh-rsa AAAAB3 admin@desk  ';
    writeFileSync(
      at('authorized_keys'),
      `${[admin, old, comment, now, '', lookalike, longer, spaced].join('\n')}\n`,
    );
    const r = run('without_deploy_lines "$D/authorized_keys"');
    expect(r).toMatchObject({ status: 0, stderr: '' });
    expect(r.stdout).toBe(`${[admin, comment, '', lookalike, longer, spaced].join('\n')}\n`);

    // Only deploy lines: nothing is left, and that is not an error.
    writeFileSync(at('authorized_keys'), `${old}\n${now}\n`);
    expect(run('without_deploy_lines "$D/authorized_keys"')).toMatchObject({
      status: 0,
      stdout: '',
    });
    // A file it cannot read fails, so the installer stops instead of keeping only its own line.
    const failed = run('{ without_deploy_lines "$D/missing"; echo LINE; } >"$D/out"; echo went on');
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).not.toContain('went on');
  });

  it('defines functions only', () => {
    const r = spawnSync(
      'bash',
      [
        '-c',
        `o=$-; . ${posix(resolve(LIB))}; [ "$-" = "$o" ] || echo changed; compgen -A function`,
      ],
      { encoding: 'utf8', cwd: dir, env: { PATH: process.env.PATH } },
    );
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual([
      'carry_path',
      'carry_settings',
      'without_deploy_lines',
    ]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

/** Asserts that each text appears in `file`, in this order. */
function expectInOrder(file: string, texts: string[]) {
  const text = readFileSync(file, 'utf8');
  let last = -1;
  for (const t of texts) {
    const i = text.indexOf(t, last + 1);
    expect(i, `${file}: ${t}`).toBeGreaterThan(last);
    last = i;
  }
}

describe('the server installers', () => {
  it('take over the auto-deploy install before writing their own', () => {
    expectInOrder('deploy/auto-deploy/install.sh', [
      '. "$HERE/../legacy-names.sh"',
      'rm -f /usr/local/sbin/agentmesh-deploy',
      'carry_settings /etc/default/agentmesh-deploy /etc/default/cosmicwave-deploy',
      'if [ ! -e /etc/default/cosmicwave-deploy ]',
      'HOME_DIR=',
      'carry_path "$HOME_DIR/.local/state/agentmesh-deploy" "$HOME_DIR/.local/state/cosmicwave-deploy"',
      '{ without_deploy_lines "$AUTH"; echo "$LINE"; } >"$AUTH.new"',
    ]);
    expect(readFileSync('deploy/auto-deploy/install.sh', 'utf8')).not.toContain('grep -v');
    // The cloud setup scripts copy the installer to the server: the library goes with it.
    expect(readFileSync('deploy/auto-deploy/github-setup.sh', 'utf8')).toContain(
      'tar -cf - -C deploy legacy-names.sh auto-deploy/cosmicwave-deploy.sh auto-deploy/install.sh',
    );
  });

  it('take over the backup install before writing their own', () => {
    expectInOrder('deploy/backup/install.sh', [
      '. "$HERE/../legacy-names.sh"',
      'systemctl disable --now "$unit"',
      'rm -f "/etc/systemd/system/$unit"',
      'carry_settings /etc/default/agentmesh-backup /etc/default/cosmicwave-backup',
      'carry_path "$HOME_DIR/.ssh/agentmesh-backup$f" "$KEY$f"',
      'carry_path /var/lib/agentmesh-backup /var/lib/cosmicwave-backup',
      'rm -f /usr/local/sbin/agentmesh-backup',
      'if [ ! -e /etc/default/cosmicwave-backup ]',
      'ssh-keygen',
      'systemctl enable --now cosmicwave-backup.timer',
    ]);
    expect(readFileSync('deploy/backup/install.sh', 'utf8')).toContain(
      'for unit in agentmesh-backup.timer agentmesh-backup.service; do',
    );
  });
});
