import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../lib/process';
import { findRepoRoot } from '../../lib/repo-paths';
import {
  AUTO_UPDATES,
  FIREWALL_SCRIPT,
  FIREWALL_SCRIPT_PATH,
  FIREWALL_UNIT,
  FIREWALL_UNIT_PATH,
  SSH_CHECK,
  WARNING,
} from './host-hardening';
import { renderHostScript } from './host-script';

const hasBash = spawnSync('bash', ['--version']).status === 0;
const script = renderHostScript({ publicHost: 'mesh.acme.dev', remoteDir: '/opt/a', user: 'u' });

/** A fake `iptables` that prints its calls, with DOCKER-USER holding a jump from an old run. */
const FAKE_IPTABLES = `iptables() {
  echo "CALL iptables $*"
  case "$1" in
    -N) return 1 ;;
    -S) printf '%s\\n' '-N DOCKER-USER' \\
      '-A DOCKER-USER -i old0 -p tcp -m conntrack --ctstate NEW --ctorigdstport 4222 --ctdir ORIGINAL -j AGENTMESH-NATS' \\
      '-A DOCKER-USER -j RETURN' ;;
  esac
}
`;

async function runFirewall(defaultRoute: string) {
  const ip = `ip() { printf '%s\\n' ${JSON.stringify(defaultRoute)}; }\n`;
  const result = await runProcess('bash', ['-s'], { input: FAKE_IPTABLES + ip + FIREWALL_SCRIPT });
  const calls = result.stdout.split('\n').filter((l) => l.startsWith('CALL '));
  return { ...result, calls: calls.map((l) => l.slice(5)) };
}

describe('host hardening', () => {
  it('setup host turns on security updates and installs the firewall after Docker', () => {
    const at = (text: string) => script.indexOf(text);
    expect(script).toContain(AUTO_UPDATES);
    expect(script).toContain(SSH_CHECK);
    expect(at('apt-get install -y -qq unattended-upgrades')).toBeGreaterThan(at('get.docker.com'));
    expect(at(`>${FIREWALL_SCRIPT_PATH}`)).toBeGreaterThan(at('get.docker.com'));
    expect(at(`>${FIREWALL_UNIT_PATH}`)).toBeLessThan(at('systemctl enable -q agentmesh-firewall'));
    expect(at('systemctl restart agentmesh-firewall.service')).toBeLessThan(at('certbot certonly'));
    expect(AUTO_UPDATES).toContain('APT::Periodic::Unattended-Upgrade "1";');
  });

  it.skipIf(!hasBash)('setup host writes the firewall script and unit byte for byte', async () => {
    for (const [path, text] of [
      [FIREWALL_SCRIPT_PATH, FIREWALL_SCRIPT],
      [FIREWALL_UNIT_PATH, FIREWALL_UNIT],
    ]) {
      const end = script.indexOf(` >${path}`);
      const write = script.slice(script.lastIndexOf("printf '%s' ", end), end);
      expect((await runProcess('bash', ['-s'], { input: write })).stdout).toBe(text);
    }
    expect((await runProcess('bash', ['-n'], { input: FIREWALL_SCRIPT })).code).toBe(0);
  });

  it('vm-setup.sh runs the same updates, firewall files and ssh check', () => {
    const root = findRepoRoot();
    if (!root) throw new Error('no repo root');
    const vmSetup = readFileSync(join(root, 'deploy', 'azure', 'vm-setup.sh'), 'utf8');
    expect(vmSetup).toContain(AUTO_UPDATES);
    expect(vmSetup).toContain(SSH_CHECK);
    expect(vmSetup).toContain(`cat >${FIREWALL_SCRIPT_PATH} <<'EOF'\n${FIREWALL_SCRIPT}EOF\n`);
    expect(vmSetup).toContain(`cat >${FIREWALL_UNIT_PATH} <<'EOF'\n${FIREWALL_UNIT}EOF\n`);
    expect(vmSetup).toContain('systemctl restart agentmesh-firewall.service');
  });

  it('runs the firewall after every Docker start', () => {
    const lines = FIREWALL_UNIT.split('\n');
    for (const line of ['After=docker.service', 'BindsTo=docker.service']) {
      expect(lines).toContain(line);
    }
    expect(lines).toContain('WantedBy=docker.service');
    expect(lines).toContain(`ExecStart=${FIREWALL_SCRIPT_PATH}`);
  });

  it.skipIf(!hasBash)(
    'limits new connections from the internet interface only, replacing an old jump',
    async () => {
      const { code, calls } = await runFirewall('default via 203.0.113.1 dev eth0 metric 100');
      expect(code).toBe(0);
      const jump = '-p tcp -m conntrack --ctstate NEW --ctorigdstport 4222 --ctdir ORIGINAL';
      expect(calls).toEqual([
        'iptables -N AGENTMESH-NATS',
        'iptables -F AGENTMESH-NATS',
        'iptables -A AGENTMESH-NATS -p tcp -m connlimit --connlimit-above 128 --connlimit-mask 32 -j REJECT --reject-with tcp-reset',
        'iptables -A AGENTMESH-NATS -m hashlimit --hashlimit-above 10/sec --hashlimit-burst 100 --hashlimit-mode srcip --hashlimit-name agentmesh-nats -j DROP',
        'iptables -A AGENTMESH-NATS -j RETURN',
        `iptables -D DOCKER-USER -i old0 ${jump} -j AGENTMESH-NATS`,
        `iptables -I DOCKER-USER 1 -i eth0 ${jump} -j AGENTMESH-NATS`,
      ]);
    },
  );

  it.skipIf(!hasBash)('stops without a default route instead of guessing', async () => {
    const { code, stderr, calls } = await runFirewall('');
    expect(code).toBe(1);
    expect(stderr).toContain('no default route; set EXT_IF');
    expect(calls).toEqual([]);
  });

  it.skipIf(!hasBash)('warns about password logins and changes nothing', async () => {
    const sshd = (settings: string) =>
      runProcess('bash', ['-s'], {
        input: `set -euo pipefail\nsshd() { ${settings}; }\n${SSH_CHECK}`,
      });
    const passwords = await sshd(
      "printf '%s\\n' 'port 22' 'passwordauthentication yes' 'permitrootlogin yes'",
    );
    expect(passwords.code).toBe(0);
    const warnings = passwords.stderr.split('\n').filter((l) => l.startsWith(WARNING));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('PasswordAuthentication no');
    expect(warnings[1]).toContain('PermitRootLogin prohibit-password');

    const keysOnly = await sshd(
      "printf '%s\\n' 'passwordauthentication no' 'permitrootlogin prohibit-password'",
    );
    expect(keysOnly).toMatchObject({ code: 0, stderr: '' });
    expect((await sshd('return 1')).stderr).toContain(`${WARNING} could not read sshd's settings`);
  });
});
