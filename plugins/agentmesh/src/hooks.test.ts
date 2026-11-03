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
      'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|EnterWorktree|Agent|Workflow',
      'mcp__plugin_agentmesh_mesh__activate',
    ]);
    expect(pre[0]?.hooks).toEqual([{ ...GUARD, timeout: 10, onFailure: 'block' }]);
    expect(pre[1]?.hooks).toEqual([{ ...GUARD, timeout: 10 }]);
    expect(hooks.description).toMatch(/guard/);
  });

  it('keeps the pull-mode hook', () => {
    for (const event of ['UserPromptSubmit', 'SessionStart']) {
      expect(hooks.hooks[event][0].hooks[0].args).toEqual([`${ROOT}/dist/hook.js`]);
    }
  });
});
