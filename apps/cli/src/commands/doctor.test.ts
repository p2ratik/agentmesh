import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../context';
import { runCli } from '../main';
import { updateEnvFile } from '../setup/env-file';
import {
  type AnswersInput,
  fakeDiscord,
  HEALTHY_CONTAINERS,
  MESH_CHANNELS,
  serverAnswers,
  trialAnswers,
} from '../setup/testing';
import { readState, workspacePaths } from '../setup/workspace';

const TOKEN = 'tok-SECRET-123';
const GUILD = '200000000000000002';
const SSH = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ControlPath=none',
];

/** A rendered workspace with the Discord values in .env, and fakes for everything doctor calls. */
async function workspace(answers: AnswersInput, channels: () => unknown = () => MESH_CHANNELS) {
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-doctor-'));
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ cmd: string; args: readonly string[]; cwd?: string }> = [];
  const connects: Array<{ servers: string[]; seedFile: string; name: string }> = [];
  const ctx: CliContext = {
    cwd,
    env: {},
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return { code: 0, stdout: HEALTHY_CONTAINERS, stderr: '' };
    },
    fetch: fakeDiscord({ [`/guilds/${GUILD}/channels`]: channels }).fetch,
    lookup: async () => ['20.1.2.3'],
    probeNatsTls: async (host, port) => ({ ok: true, label: `${host}:${port} answers TLS` }),
    connectNats: async (servers, seedFile, name) => {
      connects.push({ servers, seedFile, name });
      return { close: async () => {} };
    },
  };
  const run = (...argv: string[]) => runCli(argv, ctx);
  const p = workspacePaths(join(cwd, 'acme'));
  mkdirSync(p.root);
  writeFileSync(p.answers, JSON.stringify(answers));
  expect(await run('setup', 'render', '--dir', p.root)).toBe(0);
  out.length = 0;
  updateEnvFile(p.envFile, {
    DISCORD_BOT_TOKEN: TOKEN,
    DISCORD_APP_ID: '100000000000000001',
    DISCORD_GUILD_ID: GUILD,
  });
  return { p, ctx, out, err, calls, connects, doctor: () => run('doctor', '--dir', p.root) };
}

describe('doctor', () => {
  it('a healthy trial is live', async () => {
    const t = await workspace(trialAnswers());
    const before = readState(t.p);
    expect(await t.doctor()).toBe(0);
    expect(t.out.join('\n')).toBe(
      [
        'AgentMesh is live for Acme',
        ' ✓ nats, hub (healthy) and discord-bridge are running',
        ' ✓ Discord: category, 7 channels and the planning forum exist',
        ' ✓ riya-agent connects to nats://127.0.0.1:4222',
      ].join('\n'),
    );
    // No DNS or TLS on a trial, and compose runs here.
    expect(t.calls).toEqual([
      {
        cmd: 'docker',
        args: ['compose', '--profile', 'discord', 'ps', '--format', 'json'],
        cwd: t.p.deployDir,
      },
    ]);
    expect(t.connects).toEqual([
      {
        servers: ['nats://127.0.0.1:4222'],
        seedFile: join(t.ctx.homeDir, '.agentmesh', 'acme-riya-agent.nk'),
        name: 'doctor-riya-agent',
      },
    ]);
    expect(readState(t.p)).toEqual(before);
  });

  it('a server checks DNS and TLS, and lists the containers over ssh', async () => {
    const t = await workspace(serverAnswers());
    expect(await t.doctor()).toBe(0);
    const output = t.out.join('\n');
    expect(output).toContain(
      ' ✓ mesh.acme.dev resolves to 20.1.2.3\n ✓ mesh.acme.dev:4222 answers TLS',
    );
    expect(t.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      [
        'ssh',
        ...SSH,
        '--',
        'deploy@mesh.acme.dev',
        'cd /opt/agentmesh/deploy && docker compose --profile discord ps --format json',
      ],
    ]);
    expect(t.connects[0]?.servers).toEqual(['tls://mesh.acme.dev:4222']);
  });

  it('a Discord 403 is one problem, and the token is never printed', async () => {
    const t = await workspace(serverAnswers(), () =>
      Response.json({ message: `Missing Access ${TOKEN}` }, { status: 403 }),
    );
    expect(await t.doctor()).toBe(1);
    const output = [...t.out, ...t.err].join('\n');
    expect(output).toContain('AgentMesh for Acme: 1 problem\n');
    expect(output).toContain('answered 403: the bot has no access there');
    expect(output).not.toContain(TOKEN);
  });

  it('a guild id that is not a Discord id is never echoed (the token pasted there)', async () => {
    const t = await workspace(trialAnswers());
    updateEnvFile(t.p.envFile, { DISCORD_GUILD_ID: TOKEN });
    expect(await t.doctor()).toBe(1);
    const output = [...t.out, ...t.err].join('\n');
    expect(output).toContain('DISCORD_GUILD_ID in deploy/.env is not a Discord server id');
    expect(output).not.toContain(TOKEN);
  });

  it('a key that cannot connect fails with the reason', async () => {
    const t = await workspace(trialAnswers());
    t.ctx.connectNats = async () => {
      throw new Error('Authorization Violation');
    };
    expect(await t.doctor()).toBe(1);
    const output = t.out.join('\n');
    expect(output).toContain(' ✗ riya-agent cannot connect to nats://127.0.0.1:4222');
    expect(output).toContain('Authorization Violation');
  });
});
