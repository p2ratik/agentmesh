import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
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

/** Runs `script` in the temp folder (also $D) with bash, as `set -euo pipefail` installers do. The
 * library's path ($LIB) travels in the environment: a clone may sit in a folder with a space. */
function runRaw(script: string, env: Record<string, string> = {}) {
  const lib = env.LIB ?? posix(resolve(LIB));
  return spawnSync('bash', ['-c', `set -euo pipefail; . "$LIB"; ${script}`], {
    cwd: dir,
    env: { PATH: process.env.PATH, D: posix(dir), LIB: lib, ...env },
  });
}
function run(script: string, env: Record<string, string> = {}) {
  const r = runRaw(script, env);
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
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

  it('points carried backup settings at the moved key, and changes nothing else', () => {
    const header = '# Settings for /usr/local/sbin/agentmesh-backup (docs/configuration.md).';
    const remote = 'BACKUP_REMOTE=git@github.com:acme/agentmesh-backups.git';
    const other = '#BACKUP_SSH_KEY=$HOME/.ssh/agentmesh-backup-spare';
    const key = (path: string) => [
      `BACKUP_SSH_KEY=$HOME/.ssh/${path}`,
      `#BACKUP_SSH_KEY=$HOME/.ssh/${path}`,
      `BACKUP_SSH_KEY="/home/u/.ssh/${path}"`,
    ];
    writeFileSync(
      at('old'),
      `${[header, 'AGENTMESH_DIR=/opt/agentmesh', remote, ...key('agentmesh-backup'), other].join('\n')}\n`,
    );
    expect(run('carry_settings "$D/old" "$D/new"').status).toBe(0);
    expect(readFileSync(at('new'), 'utf8')).toBe(
      `${[header, 'COSMICWAVE_DIR=/opt/agentmesh', remote, ...key('cosmicwave-backup'), other].join('\n')}\n`,
    );
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

  // Ubuntu's default locale is C.UTF-8, and sudo keeps it. There GNU grep reads a file with an
  // invalid UTF-8 byte or a NUL as binary: it leaves such lines out (or prints "Binary file …
  // matches" in their place) and still exits 0, which would lock the admin out.
  it('keeps every other line byte for byte, whatever its bytes, in a UTF-8 locale', () => {
    const line = (text: string) => Buffer.from(`${text}\n`, 'latin1');
    const admin = line('ssh-ed25519 AAAAadmin Andr\xe9@laptop');
    const deploy = line(
      'restrict,command="/usr/local/sbin/agentmesh-deploy" ssh-ed25519 AAAAold agentmesh-github-deploy',
    );
    const nul = line('ssh-ed25519 AAAAnul a\0b');
    const other = line('ssh-ed25519 AAAAother other@desk');
    writeFileSync(at('authorized_keys'), Buffer.concat([admin, deploy, nul, other]));
    const r = runRaw('without_deploy_lines "$D/authorized_keys"', { LC_ALL: 'C.UTF-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toEqual(Buffer.concat([admin, nul, other]));
  });

  it('drops a deploy line that ends in CRLF and keeps the CR on every other line', () => {
    const admin = 'ssh-ed25519 AAAAwin admin@windows\r';
    const other = 'ssh-ed25519 AAAAz other\r';
    const lines = [
      admin,
      'restrict,command="/usr/local/sbin/agentmesh-deploy" ssh-ed25519 AAAAold agentmesh-github-deploy\r',
      'restrict,command="/usr/local/sbin/cosmicwave-deploy" ssh-ed25519 AAAAnew cosmicwave-github-deploy\r',
      other,
    ];
    writeFileSync(at('authorized_keys'), `${lines.join('\n')}\n`);
    const r = runRaw('without_deploy_lines "$D/authorized_keys"');
    expect(r.status).toBe(0);
    expect(r.stdout).toEqual(Buffer.from(`${admin}\n${other}\n`));
  });

  it('is sourced from a folder with a space in its name', () => {
    // A tester's clone sat in ".../mesh baal/cosmicwave", and every test here failed with it.
    const spaced = join(dir, 'with space');
    mkdirSync(spaced);
    copyFileSync(LIB, join(spaced, 'legacy-names.sh'));
    writeFileSync(at('old'), 'AGENTMESH_DIR=/opt/agentmesh\n');
    const r = run('carry_settings "$D/old" "$D/new"', {
      LIB: posix(join(spaced, 'legacy-names.sh')),
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(at('new'), 'utf8')).toBe('COSMICWAVE_DIR=/opt/agentmesh\n');
  });

  it('defines functions only', () => {
    const r = spawnSync(
      'bash',
      ['-c', 'o=$-; . "$LIB"; [ "$-" = "$o" ] || echo changed; compgen -A function'],
      {
        encoding: 'utf8',
        cwd: dir,
        env: { PATH: process.env.PATH, LIB: posix(resolve(LIB)) },
      },
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
