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

function setup(withClaude = true, homeName = 'home', binName = 'bin', env: CliContext['env'] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-window-'));
  const home = join(root, homeName);
  const bin = join(root, binName);
  const work = join(root, 'work');
  for (const d of [home, bin, work]) mkdirSync(d);
  if (withClaude) writeFileSync(join(bin, platform === 'win32' ? 'claude.cmd' : 'claude'), '');
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    cwd: work,
    env: { PATH: withClaude ? bin : '', PATHEXT: '.CMD', USERPROFILE: home, ...env },
    homeDir: home,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    platform,
  };
  const files = windowFiles(home, platform);
  const run = (...argv: string[]) => runCli(['window', 'init', ...argv], ctx);
  const policy = () => parseWindowPolicy(readFileSync(files.policy, 'utf8'));
  return { work, out, err, run, files, policy, home, root };
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
    expect(out).toContain(
      'A mesh window that is already running keeps working; restart it to load the new settings.',
    );
  });

  it('warns when the branch template cannot tell its own branches', async () => {
    const { out, run } = setup();
    await run('--agent', 'bob-agent', '--branch-template', 'feature/{task}');
    expect(out).toContain(
      "Warning: the branch template's prefix (the part before {task} or any other placeholder) must name {owner} or {agent} and end in /, _ or . (like agent/{owner}/). Without one the window can't tell its own branches, so task worktrees, tests, commits, pushes and PRs all ask.",
    );
  });

  it('prints the start line for this platform', async () => {
    const { out, run, work } = setup();
    await run('--agent', 'bob-agent');
    const lines =
      platform === 'win32'
        ? [
            `Start it each day in your team's folder (PowerShell or Git Bash): ~/.agentmesh/mesh-window.cmd "${work}"`,
            `In cmd: "%USERPROFILE%\\.agentmesh\\mesh-window.cmd" "${work}"`,
          ]
        : [`Start it each day in your team's folder: ~/.agentmesh/mesh-window "${work}"`];
    expect(out.slice(2, 2 + lines.length)).toEqual(lines);
  });

  it('bakes a non-ASCII home folder so the launcher still finds its files', async () => {
    const { run, files } = setup(true, 'hömé');
    expect(await run('--agent', 'bob-agent')).toBe(0);
    const launcher = readFileSync(files.launcher, 'utf8');
    if (platform === 'win32') {
      // cmd reads a .cmd file in the console's code page, not UTF-8.
      expect(launcher).toContain(
        '--settings "%USERPROFILE%\\.agentmesh\\mesh-window.settings.json"',
      );
      expect(launcher).toMatch(/^[\x20-\x7e\r\n]*$/);
    } else {
      expect(launcher).toContain(`--settings '${files.settings}'`);
    }
  });

  it.skipIf(platform !== 'win32')(
    'refuses a claude outside the home folder whose path is not ASCII',
    async () => {
      const { run, err, files } = setup(true, 'home', 'tööls');
      expect(await run('--agent', 'bob-agent')).toBe(2);
      expect(err.join('\n')).toContain('Cannot bake the path');
      expect(() => statSync(files.dir)).toThrow();
    },
  );

  it('starts the window in the Claude account CLAUDE_CONFIG_DIR names, and says which', async () => {
    const other = setup();
    await other.run('--agent', 'bob-agent');
    expect(other.out[1]).toBe('The window uses your default Claude account (~/.claude).');
    const root = mkdtempSync(join(tmpdir(), 'agentmesh-account-'));
    const account = join(root, 'claude-work');
    const { out, run, files } = setup(true, 'home', 'bin', { CLAUDE_CONFIG_DIR: account });
    expect(await run('--agent', 'bob-agent')).toBe(0);
    expect(out[1]).toBe(`The window uses the Claude account in ${account} (CLAUDE_CONFIG_DIR).`);
    expect(readFileSync(files.launcher, 'utf8')).toContain(
      platform === 'win32'
        ? `set "CLAUDE_CONFIG_DIR=${account}"`
        : `export CLAUDE_CONFIG_DIR='${account}'`,
    );
  });

  it('refuses a CLAUDE_CONFIG_DIR it cannot bake', async () => {
    const bad = platform === 'win32' ? 'C:\\R&D\\claude' : "/home/o'b/claude";
    const { run, err, files } = setup(true, 'home', 'bin', { CLAUDE_CONFIG_DIR: bad });
    expect(await run('--agent', 'bob-agent')).toBe(2);
    expect(err.join('\n')).toContain('Cannot bake the path');
    expect(() => statSync(files.dir)).toThrow();
  });

  it('refuses a CLAUDE_CONFIG_DIR that is not an absolute path', async () => {
    // Claude Code would resolve it from the team's folder, so it would name another account.
    for (const relative of ['~/.claude-b', '~\\.claude-b', 'accounts/b']) {
      const { run, err, files } = setup(true, 'home', 'bin', { CLAUDE_CONFIG_DIR: relative });
      expect(await run('--agent', 'bob-agent')).toBe(2);
      expect(err.join('\n')).toContain(
        `CLAUDE_CONFIG_DIR is ${JSON.stringify(relative)}, not an absolute path. Set it to an absolute path (no ~) and run window init again.`,
      );
      expect(() => statSync(files.dir)).toThrow();
    }
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

  it('refuses a home path it cannot bake into the launcher', async () => {
    const { run, files, err } = setup(true, platform === 'win32' ? 'R&D' : "o'b");
    expect(await run('--agent', 'bob-agent')).toBe(2);
    expect(err.join('\n')).toContain('Cannot bake the path');
    expect(() => statSync(files.dir)).toThrow();
  });

  it('refuses a --dir that is not a folder', async () => {
    const { run, files, work } = setup();
    expect(await run('--agent', 'bob-agent', '--dir', join(work, 'nope'))).toBe(2);
    expect(() => statSync(files.dir)).toThrow();
  });

  it('warns when empty-git-hooks is not empty, and deletes nothing', async () => {
    const { run, files, out } = setup();
    await run('--agent', 'bob-agent');
    writeFileSync(join(files.emptyHooks, 'pre-commit'), '');
    out.length = 0;
    expect(await run('--agent', 'bob-agent')).toBe(0);
    expect(out.at(-2)).toBe(
      `Warning: ${files.emptyHooks} is not empty; git hooks found there would run in the mesh window. Empty it.`,
    );
    expect(readdirSync(files.emptyHooks)).toEqual(['pre-commit']);
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
