import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@agentmesh/config';
import { describe, expect, it } from 'vitest';
import { listKeyHolders, setHumanDiscordId } from '../../lib/mesh-document';
import { readEnvFile, updateEnvFile } from '../../setup/env-file';
import { answersWorkspace, cliHarness, serverAnswers, trialAnswers } from '../../setup/testing';
import { markDone, type workspacePaths } from '../../setup/workspace';

const DISCORD_ENV = { DISCORD_BOT_TOKEN: 't', DISCORD_APP_ID: '1', DISCORD_GUILD_ID: '2' };

/** Every file under `dir` (relative path → sha256), to prove a run changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) =>
    f.isFile(),
  );
  return Object.fromEntries(
    files.map((f) => {
      const path = join(f.parentPath, f.name);
      return [path, createHash('sha256').update(readFileSync(path)).digest('hex')];
    }),
  );
}

const seeds = (p: ReturnType<typeof workspacePaths>, home: string) => ({
  ...snapshot(p.secretsDir),
  ...snapshot(join(home, '.agentmesh')),
});

const hubKey = (text: string) => listKeyHolders(text).find((k) => k.id === 'hub')?.nkey;

describe('setup render', () => {
  it('renders a server workspace', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, serverAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    for (const id of ['hub', 'discord-bridge', 'hub-issuer', 'hub-xkey', 'hub-sys']) {
      expect(existsSync(join(p.secretsDir, `${id}.nk`))).toBe(true);
    }
    expect(existsSync(join(h.ctx.homeDir, '.agentmesh', 'acme-riya-agent.nk'))).toBe(true);
    const conf = readFileSync(p.natsConf, 'utf8');
    expect(conf).toContain('tls {');
    expect(conf).toContain('auth_callout');
    const { config } = loadConfig(p.configDir, { env: DISCORD_ENV });
    expect(config.hub.authCallout?.issuer).toMatch(/^A/);
    expect(readFileSync(p.envFile, 'utf8')).toContain('NATS_PUBLIC_HOST=mesh.acme.dev');
    expect(readFileSync(p.claudeMd, 'utf8')).toContain('# AgentMesh workspace');
    if (process.platform !== 'win32') {
      const mode = (f: string) => statSync(f).mode & 0o777;
      expect(mode(p.envFile)).toBe(0o600);
      const keys = [p.secretsDir, join(h.ctx.homeDir, '.agentmesh')].flatMap((d) =>
        readdirSync(d)
          .filter((f) => f.endsWith('.nk'))
          .map((f) => join(d, f)),
      );
      expect(keys.length).toBeGreaterThan(5);
      for (const key of keys) expect(mode(key), key).toBe(0o600);
    }
    expect(h.out.at(-1)).toMatch(/created\s+CLAUDE\.md\n/);
    expect(h.out.at(-1)).toContain(
      `Next: paste your Discord bot token into ${p.envFile} after DISCORD_BOT_TOKEN=`,
    );
  });

  it('renders a trial workspace', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, trialAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    const conf = readFileSync(p.natsConf, 'utf8');
    expect(conf).not.toContain('tls {');
    expect(conf).not.toContain('auth_callout');
    const agents = listKeyHolders(readFileSync(p.meshFile, 'utf8')).filter(
      (k) => k.kind === 'agent',
    );
    expect(agents.map((a) => a.id)).toEqual(['riya-agent', 'riya-test-agent']);
    for (const agent of agents) expect(conf).toContain(agent.nkey as string);
    expect(existsSync(join(h.ctx.homeDir, '.agentmesh', 'acme-riya-test-agent.nk'))).toBe(true);
    expect(existsSync(join(p.secretsDir, 'hub.nk'))).toBe(true);
    expect(existsSync(join(p.secretsDir, 'discord-bridge.nk'))).toBe(true);
    expect(existsSync(join(p.secretsDir, 'hub-issuer.nk'))).toBe(false);
  });

  it('--dry-run writes nothing', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, serverAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root, '--dry-run')).toBe(0);
    expect(h.out.at(-1)).toContain('Team:');
    expect(readdirSync(p.root)).toEqual(['setup-answers.json']);
    expect(existsSync(h.ctx.homeDir)).toBe(false);
  });

  it('a second run changes nothing', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, serverAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    const before = { ...snapshot(p.root), ...snapshot(h.ctx.homeDir) };
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    expect({ ...snapshot(p.root), ...snapshot(h.ctx.homeDir) }).toEqual(before);
    expect(h.out.at(-1)).toContain('Already rendered');
  });

  it('--force keeps .env and the keys', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, serverAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    const env = readFileSync(p.envFile, 'utf8').replace(
      'DISCORD_BOT_TOKEN=',
      'DISCORD_BOT_TOKEN=tok',
    );
    writeFileSync(p.envFile, env);
    const mesh = setHumanDiscordId(readFileSync(p.meshFile, 'utf8'), 'riya', '123456789012');
    writeFileSync(p.meshFile, mesh);
    const keys = seeds(p, h.ctx.homeDir);

    // Changed answers are what --force is for: the new skill must reach mesh.yaml.
    const changed = serverAnswers();
    changed.admin.skills = ['backend', 'api', 'billing'];
    writeFileSync(p.answers, JSON.stringify(changed));
    expect(await h.run('setup', 'render', '--dir', p.root, '--force')).toBe(0);

    expect(readFileSync(p.envFile, 'utf8')).toBe(env);
    expect(seeds(p, h.ctx.homeDir)).toEqual(keys);
    const after = readFileSync(p.meshFile, 'utf8');
    expect(after).toContain('billing');
    expect(hubKey(after)).toBe(hubKey(mesh));
    const { config } = loadConfig(p.configDir, { env: DISCORD_ENV });
    expect(config.humans[0]?.discordUserId).toBe('123456789012');
    expect(config.agents[0]?.nkey).toBe(
      listKeyHolders(mesh).find((k) => k.id === 'riya-agent')?.nkey,
    );
    expect(h.out.at(-1)).toMatch(/kept\s+deploy.\.env\n/);
  });

  it('--force sets the hosting settings in a kept .env and names the others', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, trialAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    updateEnvFile(p.envFile, { DISCORD_BOT_TOKEN: 'tok' });
    const env = readEnvFile(p.envFile);

    writeFileSync(p.answers, JSON.stringify(serverAnswers()));
    const argv = ['setup', 'render', '--dir', p.root, '--force', '--registry', 'ghcr.io/other'];
    expect(await h.run(...argv)).toBe(0);

    const after = readEnvFile(p.envFile);
    expect(after.get('NATS_BIND')).toBe('0.0.0.0');
    expect(after.get('NATS_PUBLIC_HOST')).toBe('mesh.acme.dev');
    for (const key of ['DISCORD_BOT_TOKEN', 'AGENTMESH_IMAGE_REGISTRY', 'AGENTMESH_VERSION']) {
      expect(after.get(key)).toBe(env.get(key));
    }
    const line = h.out
      .at(-1)
      ?.split('\n')
      .find((l) => l.includes('.env'));
    expect(line).toMatch(
      /^\s+differs\s+deploy.\.env \(set NATS_BIND, NATS_PUBLIC_HOST; kept; edit AGENTMESH_IMAGE_REGISTRY by hand\)$/,
    );
    expect(line).not.toMatch(/DISCORD|VERSION|0\.0\.0\.0|mesh\.acme\.dev|127\.0\.0\.1|ghcr|tok/);
  });

  it('a render that leaves a trial for a server says to stop the trial first', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, trialAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    expect(h.out.at(-1)).not.toContain('docker compose --profile discord down');
    markDone(p, 'discord', new Date());

    writeFileSync(p.answers, JSON.stringify(serverAnswers()));
    expect(await h.run('setup', 'render', '--dir', p.root, '--force')).toBe(0);
    expect(h.out.at(-1)).toContain(
      `The trial still runs on this machine with the same bot token. Before setup deploy, stop ` +
        `it: run \`docker compose --profile discord down\` in ${p.deployDir}.`,
    );
    // The token is in .env already, so the server comes next.
    expect(h.out.at(-1)).toMatch(/\nNext: run setup host$/);
  });

  it("keeps a repo's .gitignore and appends only the missing secret lines", async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, trialAnswers());
    writeFileSync(p.gitignore, 'node_modules/\ndeploy/.env\n');
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    expect(readFileSync(p.gitignore, 'utf8')).toBe(
      'node_modules/\ndeploy/.env\ndeploy/.env.*\ndeploy/secrets/\ndeploy/nats/nats.conf\n*.nk\n',
    );
    expect(h.out.at(-1)).toMatch(/appended\s+\.gitignore\n/);
  });

  it('needs --dir', async () => {
    const h = cliHarness();
    expect(await h.run('setup', 'render')).toBe(2);
    expect(h.err.at(-1)).toContain('--dir');
  });

  it('refuses a --registry that would add a line to .env, before writing anything', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, serverAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root, '--registry', 'ghcr.io/x\nEVIL=1')).toBe(
      2,
    );
    expect(h.err.at(-1)).toContain('--registry');
    expect(h.err.at(-1)).not.toContain('EVIL');
    expect(readdirSync(p.root)).toEqual(['setup-answers.json']);
    expect(existsSync(h.ctx.homeDir)).toBe(false);
  });

  it('accepts a registry with a port and a namespace', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, trialAnswers());
    const registry = 'registry.example.com:5000/team';
    expect(await h.run('setup', 'render', '--dir', p.root, '--registry', registry)).toBe(0);
    expect(readFileSync(p.envFile, 'utf8').split('\n')).toContain(
      `AGENTMESH_IMAGE_REGISTRY=${registry}`,
    );
  });
});
