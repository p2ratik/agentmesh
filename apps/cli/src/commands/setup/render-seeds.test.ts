import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listKeyHolders } from '../../lib/mesh-document';
import { readEnvFile } from '../../setup/env-file';
import { answersWorkspace, cliHarness, serverAnswers } from '../../setup/testing';

describe('setup render with a seed already there', () => {
  it("another mesh's seed is never in the way, nor overwritten", async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, serverAnswers());
    const dir = join(h.ctx.homeDir, '.agentmesh');
    mkdirSync(dir, { recursive: true });
    // /agentmesh:join names its seed <agent>.nk; setup's are per mesh.
    writeFileSync(join(dir, 'riya-agent.nk'), 'SUJOINED\n');
    const seed = join(dir, 'acme-riya-agent.nk');
    writeFileSync(seed, 'SUOTHERMESH\n');
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(1);
    expect(h.err.at(-1)).toContain(`${seed} already exists`);
    expect(h.err.at(-1)).toContain('Choose another person id or move the file aside');
    expect(h.err.at(-1)).not.toContain('--force');
    expect(readFileSync(seed, 'utf8')).toBe('SUOTHERMESH\n');

    // Once the admin deals with it, a re-run continues: the keys made so far stay.
    rmSync(seed);
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    expect(h.out.at(-1)).toMatch(/unchanged\s+config.mesh\.yaml\n/);
    expect(h.out.at(-1)).not.toMatch(/key\s+hub /);
    expect(readFileSync(join(dir, 'riya-agent.nk'), 'utf8')).toBe('SUJOINED\n');
  });

  it('another person id after a seed collision renders the new agent without --force', async () => {
    const h = cliHarness();
    const p = answersWorkspace(h, serverAnswers());
    // There before setup, so render never wrote it: no re-run replaces it.
    writeFileSync(p.claudeMd, '# Our repo\n');
    const dir = join(h.ctx.homeDir, '.agentmesh');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'acme-riya-agent.nk'), 'SUOTHERMESH\n');
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(1);
    expect(h.err.at(-1)).toContain('Choose another person id or move the file aside');

    const changed = serverAnswers();
    changed.admin.id = 'riyas';
    changed.decisions = { finalSay: 'riyas' };
    Object.assign(changed.hosting, { publicHost: 'mesh2.acme.dev' });
    writeFileSync(p.answers, JSON.stringify(changed));
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(0);
    expect(h.out.at(-1)).toMatch(/replaced\s+config.mesh\.yaml\n/);
    expect(h.out.at(-1)).not.toMatch(/key\s+hub /);
    expect(readEnvFile(p.envFile).get('NATS_PUBLIC_HOST')).toBe('mesh2.acme.dev');
    const agents = listKeyHolders(readFileSync(p.meshFile, 'utf8')).filter(
      (k) => k.kind === 'agent',
    );
    expect(agents.map((a) => [a.id, a.nkey?.[0]])).toEqual([['riyas-agent', 'U']]);
    expect(existsSync(join(dir, 'acme-riyas-agent.nk'))).toBe(true);
    expect(readFileSync(join(dir, 'acme-riya-agent.nk'), 'utf8')).toBe('SUOTHERMESH\n');
    expect(readFileSync(p.claudeMd, 'utf8')).toBe('# Our repo\n');
  });

  it('a seed already in deploy/secrets keeps the keys add --force hint, run as this CLI', async () => {
    const h = cliHarness();
    h.ctx.cli = 'node "/plugin/dist/cli.js"';
    const p = answersWorkspace(h, serverAnswers());
    mkdirSync(p.secretsDir, { recursive: true });
    writeFileSync(join(p.secretsDir, 'hub.nk'), 'SUOLD\n');
    expect(await h.run('setup', 'render', '--dir', p.root)).toBe(1);
    expect(h.err.at(-1)).toContain(
      `run \`node "/plugin/dist/cli.js" keys add hub --force --config "${p.configDir}" ` +
        `--secrets "${p.secretsDir}"\``,
    );
  });
});
