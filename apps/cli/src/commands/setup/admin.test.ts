import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../context';
import { runCli } from '../../main';
import { type AnswersInput, serverAnswers, trialAnswers } from '../../setup/testing';
import { readState, workspacePaths } from '../../setup/workspace';

/** A workspace with its answers, rendered unless `render` is false (then no seed exists). */
async function workspace(answers: AnswersInput, render = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-setup-admin-'));
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    cwd,
    env: {},
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  const run = (...argv: string[]) => runCli(argv, ctx);
  const p = workspacePaths(join(cwd, 'ws'));
  mkdirSync(p.root);
  writeFileSync(p.answers, JSON.stringify(answers));
  if (render) expect(await run('setup', 'render', '--dir', p.root)).toBe(0);
  out.length = 0;
  const agentFile = join(ctx.homeDir, '.agentmesh', 'agent.json');
  const saved = () => JSON.parse(readFileSync(agentFile, 'utf8')) as Record<string, string>;
  return { p, ctx, out, err, run, agentFile, saved };
}

describe('setup admin', () => {
  it('writes agent.json for a server', async () => {
    const w = await workspace(serverAnswers());
    expect(await w.run('setup', 'admin', '--dir', w.p.root)).toBe(0);
    const saved = w.saved();
    expect(saved.agentId).toBe('riya-agent');
    expect(saved.natsUrl).toBe('tls://mesh.acme.dev:4222');
    expect(saved.nkeySeed).toBe(join(w.ctx.homeDir, '.agentmesh', 'acme-riya-agent.nk'));
    expect(saved.prefix).toBe('mesh');
    if (process.platform !== 'win32') expect(statSync(w.agentFile).mode & 0o777).toBe(0o600);
    const output = w.out.join('\n');
    expect(output).toContain(`Saved ${w.agentFile} for riya-agent.`);
    expect(output).toContain('call the AgentMesh connect tool');
    // Options that name another agent win over agent.json (the plugin's fileApplies).
    expect(output).toContain(
      "If the plugin's agent_id, nats_url or nkey_seed options are set, clear them in /plugin " +
        'and restart Claude Code: while they name another agent, the plugin ignores this file.',
    );
    expect(output).not.toContain('Restart Claude Code');
    expect(output).not.toContain('agent-setup');
    expect(readState(w.p).done.admin).toBeDefined();
    // The same agent on the same hub is not another mesh: a re-run needs no --replace.
    expect(await w.run('setup', 'admin', '--dir', w.p.root)).toBe(0);
  });

  it('refuses another mesh without --replace', async () => {
    const w = await workspace(serverAnswers());
    mkdirSync(join(w.ctx.homeDir, '.agentmesh'), { recursive: true });
    const other = `${JSON.stringify({ agentId: 'pratik-agent', natsUrl: 'nats://other:4222' })}\n`;
    writeFileSync(w.agentFile, other);

    expect(await w.run('setup', 'admin', '--dir', w.p.root)).toBe(1);
    expect(readFileSync(w.agentFile, 'utf8')).toBe(other);
    expect(w.err.join('\n')).toContain(
      'This laptop is already set up as pratik-agent on nats://other:4222. Run again with ' +
        '--replace to switch it to Acme; that agent stops working here.',
    );
    expect(readState(w.p).done.admin).toBeUndefined();

    expect(await w.run('setup', 'admin', '--dir', w.p.root, '--replace')).toBe(0);
    expect(w.saved().agentId).toBe('riya-agent');
    expect(w.out.join('\n')).toContain(
      'Restart Claude Code: the running plugin is still connected to the old mesh. Clear ' +
        'agent_id, nats_url and nkey_seed in /plugin first if they are set.',
    );
  });

  it('missing seed points at setup render', async () => {
    const w = await workspace(serverAnswers(), false);
    expect(await w.run('setup', 'admin', '--dir', w.p.root)).toBe(1);
    expect(w.err.join('\n')).toContain(join('.agentmesh', 'acme-riya-agent.nk'));
    expect(w.err.join('\n')).toContain('setup render');
    expect(readState(w.p).done.admin).toBeUndefined();
  });

  it('points a trial at this machine and prints the test agent setup', async () => {
    const w = await workspace(trialAnswers());
    // The plugin's bundled CLI is on no PATH: the hint names how this one was started.
    const cli = 'node "/plugins/agentmesh/0.4.0/dist/cli.js"';
    w.ctx.cli = cli;
    expect(await w.run('setup', 'admin', '--dir', w.p.root)).toBe(0);
    expect(w.saved().natsUrl).toBe('nats://127.0.0.1:4222');
    const seed = join(w.ctx.homeDir, '.agentmesh', 'acme-riya-test-agent.nk');
    const hint = [
      'agent-setup',
      'riya-test-agent',
      '--config',
      w.p.configDir,
      '--nats-url',
      'nats://127.0.0.1:4222',
      '--seed-file',
      seed,
    ];
    expect(w.out.join('\n')).toContain(`  ${cli} ${hint.join(' ')}`);
    // The hint works without the Discord values in the environment.
    expect(await w.run(...hint)).toBe(0);
    expect(w.out.at(-1)).toContain('Seed file: ');
  });
});
