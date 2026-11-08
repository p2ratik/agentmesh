// Shared by the tests that run the window's rules through the guard: a real checkout holding the
// window's own task worktree and a teammate's review worktree, and the check itself.
import { join } from 'node:path';
import type { WindowPolicy } from '@agentmesh/common/window';
import { expect } from 'vitest';
import { decide } from '../guard/decide';
import { fixture, mesh, put, slash } from '../guard/paths.fixture';
import { forwardReader } from '../guard/send';
import { windowRules } from './rules';

export const policy: WindowPolicy = {
  version: 1,
  agentId: 'bob-agent',
  token: 'a'.repeat(32),
  ownBranchPrefix: 'agent/bob/',
  integrationBranch: 'agents',
  testCommands: ['pnpm install --frozen-lockfile', 'pnpm check'],
};

/** [text the rules must contain, the command (or tool input) it stands for, what the guard must do]. */
export type Row = [
  string,
  string | Record<string, unknown>,
  'pass' | 'ask' | 'deny',
  tool?: string,
];

/** The checkout C (with `agents` and a teammate's branch fetched), the window's own worktree W and
 * a detached review worktree R, each quoted with forward slashes, as a command spells it. */
export function checkout(): { base: string; C: string; W: string; R: string } {
  const f = fixture();
  for (const ref of ['agents', 'agent/alice/task-2-x']) {
    put(
      join(f.repo, '.git', 'refs', 'remotes', 'origin', ...ref.split('/')),
      `${'a'.repeat(40)}\n`,
    );
  }
  const own = mesh(f.repo, 'mesh-task-1-login', 'agent/bob/task-1-login');
  const review = mesh(f.repo, 'mesh-review-task-2', 'unused');
  put(join(f.repo, '.git', 'worktrees', 'mesh-review-task-2', 'HEAD'), `${'b'.repeat(40)}\n`);
  const [C, W, R] = [f.repo, own, review].map((p) => `"${slash(p)}"`) as [string, string, string];
  return { base: f.base, C, W, R };
}

/** Each row's template is in the rules for `p`, and the guard does what the rules say, in the
 * permission `mode` Claude Code reports (none by default). Rows run in order, against forward
 * records in one folder. */
export function checkRows(
  base: string,
  p: WindowPolicy | null,
  rows: Row[],
  platform: NodeJS.Platform = process.platform,
  mode?: string,
): void {
  const text = windowRules(p);
  const home = join(base, 'home');
  const forwards = forwardReader(join(base, 'data'));
  const ctx = { marked: true, policy: p, home, platform, forwards };
  const got = rows.map(([template, input, , tool = 'Bash']) => {
    const args = typeof input === 'string' ? { command: input } : input;
    const call = { tool_name: tool, tool_input: args, cwd: base, permission_mode: mode };
    return [template, input, text.includes(template), decide(call, ctx).kind];
  });
  expect(got).toEqual(rows.map(([t, c, want]) => [t, c, true, want]));
}
