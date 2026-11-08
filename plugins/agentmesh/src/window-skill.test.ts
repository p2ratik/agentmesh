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

  const flat = SKILL.replace(/\s+/g, ' ');

  it('works right after join or connect, whose session instructions predate the mesh', () => {
    expect(flat).toContain(
      'or from the result of the `join` or `connect` tool in this conversation',
    );
    expect(flat).toContain('start a new Claude Code session and run `/agentmesh:window` there');
  });

  it('passes only the test commands the user gave, and stops on a CLI error', () => {
    expect(flat).toContain(
      'Use only the commands the user gives; if they give none, leave out `--test`',
    );
    expect(flat).toContain('Suggest the repo’s install command');
    expect(flat).toContain('show the error to the user and stop');
    expect(flat).toContain('exactly as printed');
  });

  it('starts the window in auto mode, and offers manual mode in the summary, not up front', () => {
    expect(flat).toContain(
      "The window starts in Claude Code's auto mode by default; add `--mode manual` only when the user has asked to review every command themselves. Don't ask about it up front",
    );
    expect(flat).toContain('In your final summary, say which mode the window starts in');
    expect(flat).toContain('Secrets and personal data are refused in every mode.');
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
