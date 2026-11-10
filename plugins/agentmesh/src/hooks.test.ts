import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Hook {
  type: string;
  command: string;
  args: string[];
  timeout: number;
  onFailure?: string;
}
const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
const pre = hooks.hooks.PreToolUse as Array<{ matcher: string; hooks: Hook[] }>;
/** Claude Code fills it in; spelled so it doesn't read as a template placeholder. */
const ROOT = `${'$'}{CLAUDE_PLUGIN_ROOT}`;
const GUARD = { type: 'command', command: 'node', args: [`${ROOT}/dist/guard.js`] };

describe('hooks.json', () => {
  it('runs the worktree guard before the tools it checks, blocking when it fails', () => {
    expect(pre.map((g) => g.matcher)).toEqual([
      'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|EnterWorktree|Agent|Workflow|SendMessage|ListAgents',
      'mcp__plugin_agentmesh_mesh__activate',
    ]);
    // A slow laptop (node took ~3 s to start, hooks ~18 s on 2026-11-10) waits rather than blocks.
    expect(pre[0]?.hooks).toEqual([{ ...GUARD, timeout: 60, onFailure: 'block' }]);
    expect(pre[1]?.hooks).toEqual([{ ...GUARD, timeout: 60 }]);
    expect(hooks.description).toMatch(/guard/);
  });

  it('runs the prompt and session hook on prompts, session start and session end', () => {
    for (const event of ['UserPromptSubmit', 'SessionStart', 'SessionEnd']) {
      const hook = { type: 'command', command: 'node', args: [`${ROOT}/dist/hook.js`], timeout: 5 };
      expect(hooks.hooks[event]).toEqual([{ hooks: [hook] }]);
    }
  });
});
