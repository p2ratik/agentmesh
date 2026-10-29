import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@agentmesh/config';
import { describe, expect, it } from 'vitest';
import { type CliContext, cliCommand } from './context';
import { findExamplesDir } from './lib/repo-paths';
import { runCli } from './main';

const SECRETS = {
  HERMES_INGEST_TOKEN: 'hermes-token-0123456789abcdef',
  GITHUB_WEBHOOK_SECRET: 'github-secret-0123456789abcdef',
};

function harness(env: Record<string, string | undefined> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    cwd,
    env,
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  return { cwd, ctx, out, err, run: (...argv: string[]) => runCli(argv, ctx) };
}

describe('config/examples', () => {
  it('loads cleanly, including the incident workflow and the example rules', () => {
    const { config } = loadConfig(findExamplesDir(), { env: SECRETS });
    expect(config.workflows.map((w) => w.id)).toEqual(['feature', 'review', 'incident']);
    expect(config.rules.map((r) => r.id)).toContain('ci-failed-on-shared-branches');
    expect(config.git.integrationBranch).toBe('agents');
  });
});

describe('agentmesh CLI', () => {
  it('scaffolds, validates, issues keys and renders NATS config end to end', async () => {
    const h = harness(SECRETS);
    expect(await h.run('init', 'mesh')).toBe(0);
    expect(await h.run('init', 'mesh')).toBe(1);
    expect(await h.run('validate', '--config', 'mesh')).toBe(0);
    expect(h.out.at(-1)).toContain('Agents:      3 (alice-agent, bob-agent, carol-agent)');

    expect(await h.run('nats-config', '--config', 'mesh')).toBe(2);
    expect(h.err.at(-1)).toMatch(/No nkey for: hub, alice-agent/);

    for (const id of [
      'hub',
      'alice-agent',
      'bob-agent',
      'carol-agent',
      'discord-bridge',
      'hermes',
    ]) {
      expect(await h.run('keys', 'add', id, '--config', 'mesh')).toBe(0);
    }
    const mesh = readFileSync(join(h.cwd, 'mesh', 'mesh.yaml'), 'utf8');
    expect(mesh).toContain('# One Claude Code session per person');
    expect(mesh).toMatch(
      /- id: alice-agent\n {4}owner: alice\n {4}skills: \[backend, api, aws\]\n {4}nkey: U[A-Z2-7]{55}/,
    );
    expect(readFileSync(join(h.cwd, 'secrets', 'alice-agent.nk'), 'utf8')).toMatch(
      /^SU[A-Z2-7]{56}\n$/,
    );
    expect(await h.run('keys', 'add', 'alice-agent', '--config', 'mesh')).toBe(1);
    expect(await h.run('keys', 'add', 'alice', '--config', 'mesh')).toBe(2);

    expect(await h.run('nats-config', '--config', 'mesh', '--out', 'nats.conf')).toBe(0);
    const conf = readFileSync(join(h.cwd, 'nats.conf'), 'utf8');
    expect(conf).toContain('"mesh.rpc.alice-agent.>"');
    expect(conf).toContain('"mesh.ack.alice-agent.>"');
    expect(conf).toContain('"mesh.session.alice-agent.*"');
    expect(conf).toContain('"_INBOX_bob-agent.>"');
    expect(conf).not.toContain('tls {');
    expect(await h.run('nats-config', '--config', 'mesh', '--out', 'tls.conf', '--tls')).toBe(0);
    const tls = readFileSync(join(h.cwd, 'tls.conf'), 'utf8');
    expect(tls).toContain('tls {\n  cert_file: "/etc/nats/tls/fullchain.pem"');
    expect(await h.run('nats-config', '--config', 'mesh', '--tls', '--dev')).toBe(2);
    expect(await h.run('validate', '--config', 'mesh')).toBe(0);

    expect(await h.run('keys', 'list', '--config', 'mesh')).toBe(0);
    expect(h.out.at(-1)).toContain('Every participant has a key.');
  });

  it('renders account-mode NATS config for the auth callout', async () => {
    const h = harness(SECRETS);
    await h.run('init', 'mesh');
    for (const id of ['hub', 'discord-bridge', 'hermes']) {
      expect(await h.run('keys', 'add', id, '--config', 'mesh')).toBe(0);
    }
    expect(await h.run('nats-config', '--config', 'mesh', '--auth-callout')).toBe(2);
    expect(h.err.at(-1)).toContain('hub-issuer, hub-xkey, hub-sys');

    for (const id of ['hub-issuer', 'hub-xkey', 'hub-sys']) {
      expect(await h.run('keys', 'add', id, '--config', 'mesh')).toBe(0);
    }
    const mesh = readFileSync(join(h.cwd, 'mesh', 'mesh.yaml'), 'utf8');
    expect(mesh).toMatch(/authCallout:\n {4}issuer: A[A-Z2-7]{55}\n {4}xkey: X[A-Z2-7]{55}\n/);
    expect(readFileSync(join(h.cwd, 'secrets', 'hub-xkey.nk'), 'utf8')).toMatch(/^SX/);
    expect(await h.run('keys', 'list', '--config', 'mesh')).toBe(0);
    expect(h.out.at(-1)).toContain('callout/issuer');

    // Agents have no keys yet: in callout mode they are not static users.
    expect(
      await h.run('nats-config', '--config', 'mesh', '--auth-callout', '--out', 'callout.conf'),
    ).toBe(0);
    const conf = readFileSync(join(h.cwd, 'callout.conf'), 'utf8');
    const sysKey = /sysNkey: (U[A-Z2-7]{55})/.exec(mesh)?.[1] ?? '';
    expect(conf).toContain('system_account: SYS');
    expect(conf).toMatch(/auth_callout \{\n {4}issuer: "A[A-Z2-7]{55}"\n {4}account: APP\n/);
    expect(conf).toMatch(/xkey: "X[A-Z2-7]{55}"/);
    expect(conf).toContain(sysKey);
    expect(conf).toContain('"$SYS.REQ.SERVER.*.KICK"');
    expect(conf).toContain('"mesh.rpc.discord-bridge.>"');
    expect(conf).not.toContain('alice-agent');
    // Every static user except the hub is confined; only the hub may publish ">".
    expect(conf.match(/publish: \{ allow: \[\n\s+">"/g)).toHaveLength(1);
    expect(await h.run('nats-config', '--config', 'mesh', '--auth-callout', '--dev')).toBe(2);
  });

  it('prints and optionally writes an agent setup', async () => {
    const h = harness(SECRETS);
    await h.run('init', 'mesh');
    expect(
      await h.run(
        'agent-setup',
        'bob-agent',
        '--config',
        'mesh',
        '--nats-url',
        'nats://hub.tail:4222',
        '--write',
      ),
    ).toBe(0);
    const text = h.out.at(-1) ?? '';
    expect(text).toContain(
      'claude --dangerously-load-development-channels plugin:agentmesh@agentmesh',
    );
    expect(text).toContain('mcp__plugin_agentmesh_mesh__*');
    const written = JSON.parse(
      readFileSync(join(h.ctx.homeDir, '.agentmesh', 'agent.json'), 'utf8'),
    );
    expect(written).toMatchObject({
      agentId: 'bob-agent',
      natsUrl: 'nats://hub.tail:4222',
      prefix: 'mesh',
    });
    expect(await h.run('agent-setup', 'nobody', '--config', 'mesh')).toBe(1);
  });

  it('reports config problems with paths and usage errors with exit 2', async () => {
    const h = harness();
    writeFileSync(join(h.cwd, 'mesh.yaml'), 'version: 1\nmesh: { name: x }\nhumans: []\n');
    expect(await h.run('validate')).toBe(1);
    expect(h.err.at(-1)).toContain('humans:');
    expect(await h.run('validate', '--bogus')).toBe(2);
    expect(await h.run('frobnicate')).toBe(2);
    expect(await h.run('--help')).toBe(0);
  });
});

describe('cliCommand', () => {
  it('names how to run this CLI again, since it is on no PATH', () => {
    const bundle =
      'C:\\Users\\riya\\.claude\\plugins\\cache\\agentmesh\\agentmesh\\0.4.0\\dist\\cli.js';
    expect(cliCommand(bundle)).toBe(`node "${bundle}"`);
    expect(cliCommand('/repo/apps/cli/src/main.ts')).toBe('pnpm mesh');
    expect(cliCommand(undefined)).toBe('agentmesh');
  });
});
