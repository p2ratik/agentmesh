import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@agentmesh/common';
import { afterAll, describe, expect, it } from 'vitest';
import { trialAnswers } from '../../apps/cli/src/setup/testing';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { loadConfig } from '../../packages/config/src/load';
import { type Agent, PLUGIN, PLUGIN_CLI, spawnAgent, untilConnected } from './support';

/**
 * `/agentmesh:setup` without Claude: the CLI bundled in the plugin renders a trial
 * workspace, the hub starts from it against a real nats-server, `setup admin` saves
 * the admin's agent and an unenrolled plugin connects with `connect`. No Docker, no
 * Discord. Needs AGENTMESH_TEST_NATS_BIN and a built plugin (dist/server.js, dist/cli.js).
 */
const NATS_BIN = process.env.AGENTMESH_TEST_NATS_BIN ?? '';
const PORT = 7600 + Math.floor(Date.now() % 400);
const URL = `nats://127.0.0.1:${PORT}`;
/** Only `setup discord` writes these to .env; the hub checks them, the bridge never starts. */
const DISCORD_ENV = {
  DISCORD_BOT_TOKEN: 'placeholder-token',
  DISCORD_APP_ID: '100000000000000001',
  DISCORD_GUILD_ID: '100000000000000002',
};

describe.skipIf(
  !NATS_BIN || !existsSync(NATS_BIN) || !existsSync(PLUGIN) || !existsSync(PLUGIN_CLI),
)('setup end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-setup-'));
  const ws = join(dir, 'acme');
  const home = join(dir, 'home');
  /** Runs the bundled CLI the way the skill does, with the temp home as `~`. */
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [PLUGIN_CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
  let server: ChildProcess | undefined;
  let hub: Hub | undefined;
  let agent: Agent | undefined;

  afterAll(async () => {
    await agent?.client.close().catch(() => undefined);
    await hub?.stop();
    server?.kill();
  });

  it('lists the setup steps', () => {
    const help = cli('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('setup render');
  });

  it('renders a trial workspace from the answers', () => {
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'setup-answers.json'), JSON.stringify(trialAnswers()));
    const rendered = cli('setup', 'render', '--dir', ws);
    expect(rendered.stderr).toBe('');
    expect(rendered.status).toBe(0);
    expect(existsSync(join(home, '.agentmesh', 'riya-agent.nk'))).toBe(true);
  });

  it('starts the hub from the workspace, and the admin agent connects', async () => {
    const conf = readFileSync(join(ws, 'deploy', 'nats', 'nats.conf'), 'utf8')
      .replace('port: 4222', `port: ${PORT}`)
      .replace('http: "127.0.0.1:8222"', '')
      .replace('"/data/jetstream"', JSON.stringify(join(dir, 'js')));
    writeFileSync(join(dir, 'nats.conf'), conf);
    server = spawn(NATS_BIN, ['-c', join(dir, 'nats.conf'), '-a', '127.0.0.1'], {
      stdio: 'ignore',
    });
    const loaded = loadConfig(join(ws, 'config'), { env: DISCORD_ENV });
    // Port 8787 may be taken on this machine; ingest is not under test.
    loaded.config.hub.http.enabled = false;
    hub = await createHub({
      loaded,
      dataDir: ':memory:',
      nats: { servers: [URL], credentials: { nkeySeed: join(ws, 'deploy', 'secrets', 'hub.nk') } },
      // Not `warn`: the trial's area owner dana is not on the team yet, which the hub warns about.
      logger: createLogger('setup-hub', { level: 'error', destination: 'stderr' }),
    });
    await hub.start();

    // Claude Code was started before setup saved anything, so the plugin is unenrolled.
    const joiner = await spawnAgent({ agentId: '', natsUrl: '', prefix: 'mesh', home });
    agent = joiner;
    const admin = cli('setup', 'admin', '--dir', ws);
    expect(admin.stderr).toBe('');
    expect(admin.status).toBe(0);
    // A trial hub listens on 127.0.0.1:4222; this test's nats-server listens on PORT.
    const agentFile = join(home, '.agentmesh', 'agent.json');
    const saved = JSON.parse(readFileSync(agentFile, 'utf8'));
    expect(saved).toMatchObject({ agentId: 'riya-agent', prefix: 'mesh' });
    writeFileSync(agentFile, JSON.stringify({ ...saved, natsUrl: URL }));

    expect(await joiner.call('connect', {})).toContain('Connected as riya-agent');
    expect(await untilConnected(() => joiner.call('peers', {}))).toContain('riya-agent');
  }, 60_000);
});
