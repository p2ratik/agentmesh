import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The server installers on a server set up before the rename (legacy-names.test.ts tests the
// functions they use). They need root, so these tests read their text, or run one slice of it
// with fakes against a temp folder; nothing touches a real system path.
const hasBash =
  spawnSync('bash', ['-c', '[ "$PROBE" = 1 ]'], { env: { ...process.env, PROBE: '1' } }).status ===
  0;

const posix = (p: string) =>
  p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replaceAll('\\', '/');

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
      // The checkout check uses the folder the settings name (an old server keeps /opt/agentmesh).
      'COSMICWAVE_DIR=$(. /etc/default/cosmicwave-deploy',
      '[ -f "$COSMICWAVE_DIR/deploy/docker-compose.yml" ]',
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

/**
 * The backup installer's loop over the old units, then its line that enables the new timer, run
 * with a fake systemctl (failing on the call named in FAIL) and unit files in a temp folder.
 */
function backupUnits(fail: string, files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cosmicwave-units-'));
  try {
    const text = readFileSync('deploy/backup/install.sh', 'utf8');
    const start = text.indexOf('for unit in agentmesh-backup.timer');
    const loop = text.slice(start, text.indexOf('\ndone\n', start) + 6);
    const enable = text.match(/^ *systemctl enable --now cosmicwave-backup\.timer.*$/m)?.[0];
    for (const f of files) writeFileSync(join(dir, f), '[Unit]\n');
    const fakes = `systemctl() { echo "CALL systemctl $*"; [ "$*" != "$FAIL" ]; }
rm() { echo "CALL rm $*"; }
`;
    const units = `${posix(dir)}/`;
    const r = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\n${fakes}${loop.replaceAll('/etc/systemd/system/', units)}${enable}\necho went on`,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH, FAIL: fail } },
    );
    const calls = r.stdout.split('\n').filter((l) => l.startsWith('CALL '));
    return { ...r, calls: calls.map((l) => l.slice(5).replace(units, '')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasBash)('the backup installer on old units', () => {
  it('goes on when an old unit is absent, static or cannot be stopped, with a warning', () => {
    const r = backupUnits('disable --now agentmesh-backup.service', ['agentmesh-backup.service']);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      'systemctl disable --now agentmesh-backup.service',
      'rm -f agentmesh-backup.service',
    ]);
    expect(r.stderr).toContain('agentmesh-backup.service');
    expect(r.stdout).toContain('went on');
  });

  it('stops when the new timer cannot be enabled', () => {
    const r = backupUnits('enable --now cosmicwave-backup.timer', [
      'agentmesh-backup.timer',
      'agentmesh-backup.service',
    ]);
    expect(r.status).not.toBe(0);
    expect(r.calls.slice(0, 4)).toEqual([
      'systemctl disable --now agentmesh-backup.timer',
      'rm -f agentmesh-backup.timer',
      'systemctl disable --now agentmesh-backup.service',
      'rm -f agentmesh-backup.service',
    ]);
    expect(r.stdout).not.toContain('went on');
  });
});
