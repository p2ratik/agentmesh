import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@agentmesh/config';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../context';
import { listKeyHolders, setHumanDiscordId } from '../../lib/mesh-document';
import { runCli } from '../../main';
import { parseAnswers } from '../../setup/answers';
import { renderStatus } from '../../setup/render/status';
import { type AnswersInput, serverAnswers, trialAnswers } from '../../setup/testing';
import { workspacePaths } from '../../setup/workspace';

const DISCORD_ENV = { DISCORD_BOT_TOKEN: 't', DISCORD_APP_ID: '1', DISCORD_GUILD_ID: '2' };

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-setup-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    cwd,
    env: {},
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  return { cwd, ctx, out, err, run: (...argv: string[]) => runCli(argv, ctx) };
}

/** A workspace holding only `setup-answers.json`. */
function workspace(h: ReturnType<typeof harness>, answers: AnswersInput) {
  const p = workspacePaths(join(h.cwd, 'ws'));
  mkdirSync(p.root);
  writeFileSync(p.answers, JSON.stringify(answers));
  return p;
}

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
    const h = harness();
    const p = workspace(h, serverAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    for (const id of ['hub', 'discord-bridge', 'hub-issuer', 'hub-xkey', 'hub-sys']) {
      expect(existsSync(join(p.secretsDir, `${id}.nk`))).toBe(true);
    }
    expect(existsSync(join(h.ctx.homeDir, '.agentmesh', 'riya-agent.nk'))).toBe(true);
    const conf = readFileSync(p.natsConf, 'utf8');
    expect(conf).toContain('tls {');
    expect(conf).toContain('auth_callout');
    const { config } = loadConfig(p.configDir, { env: DISCORD_ENV });
    expect(config.hub.authCallout?.issuer).toMatch(/^A/);
    expect(readFileSync(p.envFile, 'utf8')).toContain('NATS_PUBLIC_HOST=mesh.acme.dev');
    expect(h.out.at(-1)).toContain(
      `Next: paste your Discord bot token into ${p.envFile} after DISCORD_BOT_TOKEN=`,
    );
  });

  it('renders a trial workspace', async () => {
    const h = harness();
    const p = workspace(h, trialAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    const conf = readFileSync(p.natsConf, 'utf8');
    expect(conf).not.toContain('tls {');
    expect(conf).not.toContain('auth_callout');
    const agents = listKeyHolders(readFileSync(p.meshFile, 'utf8')).filter(
      (k) => k.kind === 'agent',
    );
    expect(agents.map((a) => a.id)).toEqual(['riya-agent', 'riya-test-agent']);
    for (const agent of agents) expect(conf).toContain(agent.nkey as string);
    expect(existsSync(join(h.ctx.homeDir, '.agentmesh', 'riya-test-agent.nk'))).toBe(true);
    expect(existsSync(join(p.secretsDir, 'hub.nk'))).toBe(true);
    expect(existsSync(join(p.secretsDir, 'discord-bridge.nk'))).toBe(true);
    expect(existsSync(join(p.secretsDir, 'hub-issuer.nk'))).toBe(false);
  });

  it('--dry-run writes nothing', async () => {
    const h = harness();
    const p = workspace(h, serverAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root, '--dry-run')).toBe(0);
    expect(h.out.at(-1)).toContain('Team:');
    expect(readdirSync(p.root)).toEqual(['setup-answers.json']);
    expect(existsSync(h.ctx.homeDir)).toBe(false);
  });

  it('a second run changes nothing', async () => {
    const h = harness();
    const p = workspace(h, serverAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    const before = { ...snapshot(p.root), ...snapshot(h.ctx.homeDir) };
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    expect({ ...snapshot(p.root), ...snapshot(h.ctx.homeDir) }).toEqual(before);
    expect(h.out.at(-1)).toContain('Already rendered');
  });

  it('--force keeps .env and the keys', async () => {
    const h = harness();
    const p = workspace(h, serverAnswers());
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
  });

  it('an existing admin seed is not overwritten', async () => {
    const h = harness();
    const p = workspace(h, serverAnswers());
    const seed = join(h.ctx.homeDir, '.agentmesh', 'riya-agent.nk');
    mkdirSync(join(h.ctx.homeDir, '.agentmesh'), { recursive: true });
    writeFileSync(seed, 'SUOTHERMESH\n');
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(1);
    expect(h.err.at(-1)).toContain('keys add riya-agent --force');
    expect(readFileSync(seed, 'utf8')).toBe('SUOTHERMESH\n');

    // Once the admin deals with it, a re-run continues: the keys made so far stay.
    rmSync(seed);
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    expect(h.out.at(-1)).toMatch(/unchanged\s+config.mesh\.yaml\n/);
    expect(h.out.at(-1)).not.toMatch(/key\s+hub /);
  });

  it('needs --dir', async () => {
    const h = harness();
    expect(await h.run('setup', 'render')).toBe(2);
    expect(h.err.at(-1)).toContain('--dir');
  });
});

describe('setup status', () => {
  it('prints the next step of a rendered workspace', async () => {
    const h = harness();
    const p = workspace(h, trialAnswers());
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    expect(await h.run('setup', 'status', '--dir', p.root)).toBe(0);
    expect(h.out.at(-1)).toMatch(/Next: run setup discord$/);
  });

  it('follows the steps, skipping host on a trial', () => {
    const at = '2026-10-23T10:00:00.000Z';
    const server = parseAnswers(serverAnswers());
    const trial = parseAnswers(trialAnswers());
    const done = (...steps: string[]) => ({
      version: 1 as const,
      done: Object.fromEntries(steps.map((s) => [s, at])),
    });
    expect(renderStatus(done(), server)).toMatch(/Next: run setup render$/);
    expect(renderStatus(done('render', 'discord'), server)).toMatch(/Next: run setup host$/);
    expect(renderStatus(done('render', 'discord'), trial)).toMatch(/Next: run setup deploy$/);
    expect(renderStatus(done('render', 'discord', 'deploy', 'admin'), trial)).toMatch(
      /Next: run doctor, then \/agentmesh:activate, then setup invites$/,
    );
  });
});
