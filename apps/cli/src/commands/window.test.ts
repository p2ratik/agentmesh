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
import { describe, expect, it } from 'vitest';
import { platform, setup } from './window.fixture';

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

  it('starts the window in auto mode by default, or in manual mode with --mode manual', async () => {
    const settings = (files: { settings: string }) =>
      JSON.parse(readFileSync(files.settings, 'utf8')).permissions;
    const auto = setup();
    expect(await auto.run('--agent', 'bob-agent')).toBe(0);
    expect(auto.policy()?.mode).toBe('auto');
    expect(settings(auto.files).defaultMode).toBe('auto');
    expect(readFileSync(auto.files.launcher, 'utf8')).toContain('--permission-mode auto ');
    expect(auto.out).toContain(
      "It starts in auto mode: commands not on its list go to auto mode's checks, and secrets stay blocked. To have them ask you instead, run window init again with --mode manual.",
    );
    const manual = setup();
    expect(await manual.run('--agent', 'bob-agent', '--mode', 'manual')).toBe(0);
    expect(manual.policy()?.mode).toBe('manual');
    expect(settings(manual.files)).toMatchObject({
      defaultMode: 'default',
      disableAutoMode: 'disable',
    });
    expect(readFileSync(manual.files.launcher, 'utf8')).toContain('--permission-mode default ');
    expect(manual.out).toContain('It starts in manual mode: commands not on its list ask you.');
  });

  it('refuses a --mode other than auto or manual, writing nothing', async () => {
    for (const mode of ['default', 'Auto', 'bypassPermissions', '']) {
      const { run, files, err } = setup();
      expect(await run('--agent', 'bob-agent', '--mode', mode)).toBe(2);
      expect(err.join('\n')).toContain('--mode is auto or manual');
      expect(() => statSync(files.dir)).toThrow();
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

  it('warns about a claude-mesh function in a shell profile, and still succeeds', async () => {
    const t = setup();
    const bashrc = join(t.home, '.bashrc');
    const profile =
      platform === 'win32' ? join(t.home, 'Documents', 'WindowsPowerShell', 'profile.ps1') : bashrc;
    mkdirSync(join(profile, '..'), { recursive: true });
    writeFileSync(profile, '# old\nfunction claude-mesh {\n  claude --x\n}\n');
    writeFileSync(bashrc, 'export A=1\nalias claude-mesh=claude\n');
    const warn = (file: string, line: number) =>
      `Warning: ${file}:${line} defines claude-mesh, which runs instead of the launcher in that shell. Remove or rename it, then open a new terminal.`;
    const expected = profile === bashrc ? [warn(bashrc, 2)] : [warn(profile, 2), warn(bashrc, 2)];
    expect(await t.run('--agent', 'alice-agent')).toBe(0);
    expect(t.out.filter((l) => l.includes('defines claude-mesh'))).toEqual(expected);
  });

  it('prints no shadow warning for a clean home', async () => {
    const t = setup();
    writeFileSync(join(t.home, '.bashrc'), 'export A=1\nalias ll=ls\n');
    expect(await t.run('--agent', 'alice-agent')).toBe(0);
    expect(t.out.filter((l) => l.includes('defines claude-mesh'))).toEqual([]);
  });
});
