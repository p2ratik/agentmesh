import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../lib/process';
import { renderHostScript } from './host-script';

const hasBash = spawnSync('bash', ['--version']).status === 0;

const script = renderHostScript({
  publicHost: 'mesh.acme.dev',
  remoteDir: '/opt/agentmesh',
  user: 'deploy',
});

describe('renderHostScript', () => {
  it('bakes in the values and follows vm-setup.sh without git', () => {
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain("PUBLIC_HOST='mesh.acme.dev'");
    expect(script).toContain("MESH_USER='deploy'");
    expect(script).toContain('Ubuntu 24.04 is the tested target');
    expect(script).toContain('certbot certonly --standalone');
    expect(script).toContain('/opt/agentmesh/deploy/docker-compose.yml');
    expect(script).toContain('usermod -aG docker "$MESH_USER"');
    expect(script).not.toMatch(/\bgit\b/);
  });

  it('waits for apt on a new server and refuses a Docker without Compose v2', () => {
    const at = (text: string) => script.indexOf(text);
    expect(at('cloud-init status --wait')).toBeGreaterThan(-1);
    expect(at('cloud-init status --wait')).toBeLessThan(at('apt-get update'));
    expect(at('DPkg::Lock::Timeout "300";')).toBeLessThan(at('apt-get update'));
    expect(at('docker compose version')).toBeGreaterThan(at('get.docker.com'));
    expect(at('docker compose version')).toBeLessThan(at('apt-get install -y -qq certbot'));
    expect(script).toMatch(
      /docker compose version >\/dev\/null 2>&1 \|\| \{\n.*docker-compose-v2.*\n\s+exit 1\n\}/,
    );
  });

  it('creates the workspace folders for the ssh user and gets a certificate only once', () => {
    for (const dir of ['', '/deploy', '/deploy/nats', '/deploy/secrets', '/config']) {
      expect(script).toContain(`"$AGENTMESH_DIR${dir}"`);
    }
    expect(script).toContain('chown "$MESH_USER:"');
    expect(script).toMatch(
      /if \[ ! -d "\/etc\/letsencrypt\/live\/\$PUBLIC_HOST" \]; then\n\s+certbot/,
    );
    expect(script.indexOf('certbot certonly')).toBeLessThan(script.lastIndexOf('"$HOOK"'));
  });

  it.skipIf(!hasBash)('is valid bash', async () => {
    const result = await runProcess('bash', ['-n'], { input: script });
    expect(result).toMatchObject({ code: 0, stderr: '' });
  });

  it.skipIf(!hasBash)(
    'quotes a value with a single quote, in the script and the hook',
    async () => {
      const odd = renderHostScript({
        publicHost: "it's.dev",
        remoteDir: "/opt/a'b",
        user: "o'neil",
      });
      expect(odd).toContain(`MESH_USER='o'\\''neil'`);
      expect((await runProcess('bash', ['-n'], { input: odd })).code).toBe(0);
      expect(await valuesOf(odd, ['PUBLIC_HOST', 'AGENTMESH_DIR', 'MESH_USER'])).toEqual([
        "it's.dev",
        "/opt/a'b",
        "o'neil",
      ]);

      // The hook is written with `printf '%s' <quoted hook> >"$HOOK"`; print it instead.
      const hookAt = odd.indexOf('== certificate renewal hook');
      const write = odd.slice(odd.indexOf("printf '%s' ", hookAt), odd.indexOf(' >"$HOOK"'));
      const hook = (await runProcess('bash', ['-s'], { input: write })).stdout;
      expect(hook).toMatch(/^#!\/bin\/sh\n/);
      expect((await runProcess('bash', ['-n'], { input: hook })).code).toBe(0);
      expect(await valuesOf(hook, ['LIVE', 'TLS_DIR'])).toEqual([
        "/etc/letsencrypt/live/it's.dev",
        "/opt/a'b/deploy/nats/tls",
      ]);
    },
  );
});

/** Runs the `NAME=…` lines of `text` for `names` in bash and prints them: the quoting round trip. */
async function valuesOf(text: string, names: string[]): Promise<string[]> {
  const lines = text.split('\n');
  const assignments = names.map((n) => lines.find((line) => line.startsWith(`${n}=`)));
  const print = `printf '%s\\n' ${names.map((n) => `"$${n}"`).join(' ')}`;
  const result = await runProcess('bash', ['-s'], { input: [...assignments, print].join('\n') });
  return result.stdout.split('\n').slice(0, -1);
}
