import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '@agentmesh/cli';
import { describe, expect, it } from 'vitest';

const SKILL = readFileSync(join(import.meta.dirname, '../skills/autoupdate/SKILL.md'), 'utf8');

describe('the /agentmesh:autoupdate skill', () => {
  it('is user-only and pre-approves no tool', () => {
    const frontmatter = SKILL.split('---')[1] ?? '';
    expect(frontmatter).toContain('disable-model-invocation: true');
    expect(frontmatter).not.toContain('allowed-tools');
  });

  it('runs only the bundled CLI autoupdate step, on or off', () => {
    const calls = [...SKILL.matchAll(/node "[^"]*" [^`\n]*/g)].map((m) => m[0]);
    // Claude Code substitutes the plugin root in skill text; the test spells it literally.
    const cli = `node "${'$'}{CLAUDE_PLUGIN_ROOT}/dist/cli.js"`;
    expect(calls).toEqual([`${cli} autoupdate --off`, `${cli} autoupdate`]);
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
    expect(await runCli(['autoupdate', '--help'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('autoupdate');
  });
});
