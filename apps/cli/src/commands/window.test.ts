import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWindowPolicy, windowFiles } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../context';
import { runCli } from '../main';

const platform = process.platform;

function setup(withClaude = true) {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-window-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  for (const d of [home, bin, work]) mkdirSync(d);
  if (withClaude) writeFileSync(join(bin, platform === 'win32' ? 'claude.cmd' : 'claude'), '');
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    cwd: work,
    env: { PATH: withClaude ? bin : '', PATHEXT: '.CMD' },
    homeDir: home,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    platform,
  };
  const files = windowFiles(home, platform);
  const run = (...argv: string[]) => runCli(['window', 'init', ...argv], ctx);
  const policy = () => parseWindowPolicy(readFileSync(files.policy, 'utf8'));
  return { work, out, err, run, files, policy, home };
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe('agentmesh window init', () => {
  it('writes the launcher, its settings and the policy', async () => {
    const { out, run, files, policy } = setup();
    expect(await run('--agent', 'bob-agent', '--owner', 'bob', '--test', 'pnpm check')).toBe(0);
    expect(policy()).toMatchObject({
      agentId: 'bob-agent',
      ownBranchPrefix: 'agent/bob/',
      integrationBranch: 'agents',
      testCommands: ['pnpm check'],
    });
    const settings = JSON.parse(readFileSync(files.settings, 'utf8'));
    expect(settings.env.AGENTMESH_MESH_WINDOW).toBe(policy()?.token);
    expect(readFileSync(files.launcher, 'utf8')).toContain(policy()?.token);
    expect(readdirSync(files.emptyHooks)).toEqual([]);
    expect(out[0]).toBe(
      `Wrote your mesh window for bob-agent: ${files.launcher}, ${files.settings} and ${files.policy}.`,
    );
    expect(out.at(-1)).toBe(
      "Check that each repo's test runner, typechecker and linter skip .claude/worktrees/ (vitest's default include does not).",
    );
    if (platform !== 'win32') {
      expect([mode(files.policy), mode(files.settings), mode(files.launcher)]).toEqual([
        0o600, 0o600, 0o700,
      ]);
      expect(mode(files.emptyHooks)).toBe(0o700);
    }
  });

  it('keeps the token when it runs again', async () => {
    const { out, run, policy } = setup();
    await run('--agent', 'bob-agent');
    const first = policy()?.token;
    out.length = 0;
    expect(await run('--agent', 'bob-agent')).toBe(0);
    expect(policy()?.token).toBe(first);
    expect(out[2]).toBe(
      'A mesh window that is already running keeps working; restart it to load the new settings.',
    );
  });

  it('warns when the branch template cannot tell its own branches', async () => {
    const { out, run } = setup();
    await run('--agent', 'bob-agent', '--branch-template', 'feature/{task}');
    expect(out.some((l) => l.startsWith('Warning: the branch template names neither'))).toBe(true);
  });

  it('refuses unsafe input', async () => {
    for (const bad of [
      ['--agent', 'Bob'],
      ['--agent', 'bob-agent', '--test', 'pnpm test; rm -rf ~'],
      ['--agent', 'bob-agent', '--integration-branch', '../main'],
    ]) {
      const { run, files } = setup();
      expect(await run(...bad)).toBe(2);
      expect(() => statSync(files.dir)).toThrow();
    }
  });

  it('says when claude is not on PATH', async () => {
    const { err, run, files } = setup(false);
    expect(await run('--agent', 'bob-agent')).toBe(1);
    expect(err).toEqual(['error: claude is not on PATH. Install Claude Code first.']);
    expect(() => statSync(files.dir)).toThrow();
  });

  it('warns about a checkout that does not ignore its worktrees', async () => {
    const { work, out, run } = setup();
    mkdirSync(join(work, 'web', '.git'), { recursive: true });
    mkdirSync(join(work, 'api', '.git'), { recursive: true });
    writeFileSync(join(work, 'api', '.gitignore'), 'dist/\n.claude/\n');
    expect(await run('--agent', 'bob-agent', '--dir', work)).toBe(0);
    const warns = out.filter((l) => l.includes("doesn't ignore .claude/worktrees/"));
    expect(warns).toEqual([
      `Warning: ${join(work, 'web')} doesn't ignore .claude/worktrees/; add it to .gitignore so the window's worktrees don't show up as untracked files.`,
    ]);
  });
});
