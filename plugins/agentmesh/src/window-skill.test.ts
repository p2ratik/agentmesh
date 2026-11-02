import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '@agentmesh/cli';
import { describe, expect, it } from 'vitest';

const SKILL = readFileSync(join(import.meta.dirname, '../skills/window/SKILL.md'), 'utf8');

describe('the /agentmesh:window skill', () => {
  it('is user-only and pre-approves no tool', () => {
    const frontmatter = SKILL.split('---')[1] ?? '';
    expect(frontmatter).toContain('disable-model-invocation: true');
    expect(frontmatter).not.toContain('allowed-tools');
  });

  it('runs only the bundled CLI window init step', () => {
    const calls = [...SKILL.matchAll(/node "[^"]*" [^`\n]*/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // Claude Code substitutes the plugin root in skill text; the test spells it literally.
      expect(call).toMatch(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" window init /);
    }
  });

  it('never lets Claude run the launcher', () => {
    expect(SKILL).toContain('Never run the launcher yourself');
  });

  it('names a step the CLI has', async () => {
    const out: string[] = [];
    const ctx = {
      cwd: '.',
      env: {},
      homeDir: '.',
      stdout: out.push.bind(out),
      stderr: out.push.bind(out),
    };
    expect(await runCli(['window', 'init', '--help'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('window');
  });
});
