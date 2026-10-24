import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '@agentmesh/cli';
import { describe, expect, it } from 'vitest';

const SKILL = readFileSync(join(import.meta.dirname, '../skills/setup/SKILL.md'), 'utf8');

describe('the /agentmesh:setup skill', () => {
  it('is user-only and pre-approves no tool', () => {
    const frontmatter = SKILL.split('---')[1] ?? '';
    expect(frontmatter).toContain('disable-model-invocation: true');
    expect(frontmatter).not.toContain('allowed-tools');
  });

  it('forbids the Docker commands that print .env values', () => {
    for (const cmd of ['docker compose config', 'docker inspect', 'printenv']) {
      expect(SKILL).toContain(cmd);
    }
  });

  it('runs every CLI step the same way, from the bundled CLI', () => {
    const calls = [...SKILL.matchAll(/node "[^"]*" [^`\n]*/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(call).toMatch(
        /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" [a-z <>]+ --dir "<workspace>"/,
      );
    }
  });

  it('shows Claude an answers file that the CLI accepts', async () => {
    const example = /```json\n([\s\S]*?)```/.exec(SKILL)?.[1] ?? '';
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-skill-'));
    writeFileSync(join(dir, 'setup-answers.json'), example);
    const out: string[] = [];
    const ctx = {
      cwd: dir,
      env: {},
      homeDir: dir,
      stdout: out.push.bind(out),
      stderr: out.push.bind(out),
    };
    expect(await runCli(['setup', 'render', '--dir', dir, '--dry-run'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('Acme');
  });
});
