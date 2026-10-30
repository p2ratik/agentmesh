import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../context';
import { runCli } from '../main';

function setup(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentmesh-autoupdate-'));
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    cwd: home,
    env,
    homeDir: home,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  const run = (...argv: string[]) => runCli(['autoupdate', ...argv], ctx);
  return { home, out, err, run };
}

const entry = (file: string) => JSON.parse(readFileSync(file, 'utf8')).extraKnownMarketplaces;

describe('agentmesh autoupdate', () => {
  it('creates settings.json, then reports nothing changed on a second run', async () => {
    const { home, out, run } = setup();
    const file = join(home, '.claude', 'settings.json');
    expect(await run()).toBe(0);
    expect(out[0]).toBe(
      `Turned on auto-update for the "agentmesh" plugin marketplace in ${file}. Claude Code downloads new versions in the background; run /reload-plugins or restart Claude Code to load one.`,
    );
    expect(entry(file)).toEqual({
      agentmesh: { source: { source: 'github', repo: 'p2ratik/agentmesh' }, autoUpdate: true },
    });
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(await run()).toBe(0);
    expect(out[1]).toBe(
      `Auto-update for the "agentmesh" plugin marketplace was already on in ${file}; nothing changed.`,
    );
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('uses $CLAUDE_CONFIG_DIR and the source from its known_marketplaces.json', async () => {
    const { home, run } = setup({ CLAUDE_CONFIG_DIR: 'second' });
    const dir = join(home, 'second');
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    const source = { source: 'git', url: 'https://git.acme.dev/agentmesh.git' };
    writeFileSync(
      join(dir, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ agentmesh: { source, installLocation: dir, lastUpdated: 'x' } }),
    );
    writeFileSync(join(dir, 'settings.json'), '{\n  "model": "opus"\n}\n');
    expect(await run('--off')).toBe(0);
    expect(entry(join(dir, 'settings.json'))).toEqual({ agentmesh: { source, autoUpdate: false } });
  });

  it.skipIf(process.platform === 'win32')('keeps the file’s mode', async () => {
    const { home, run } = setup();
    const file = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'));
    writeFileSync(file, '{}');
    chmodSync(file, 0o640);
    expect(await run()).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it('refuses a settings.json that is not JSON, changes nothing and never prints it', async () => {
    const { home, out, err, run } = setup();
    const file = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'));
    const broken = '{"env": {"API_TOKEN": "tok-SECRET-123"},';
    writeFileSync(file, broken);
    expect(await run()).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(broken);
    expect(err.join('\n')).toContain('Nothing was changed');
    expect([...out, ...err].join('\n')).not.toContain('SECRET');
  });

  it('refuses a marketplace name Claude Code does not know', async () => {
    const { home, err, run } = setup();
    expect(await run('--marketplace', 'acme')).toBe(2);
    expect(err.join('\n')).toContain('no marketplace named "acme"');
    expect(() => statSync(join(home, '.claude', 'settings.json'))).toThrow();
  });
});
