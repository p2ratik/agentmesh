import { CHANNEL_FLAG, LAUNCH_PROMPT, windowFiles } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import {
  bakeable,
  bakedPath,
  isOurShim,
  launcherScript,
  sessionName,
  shimScripts,
  windowSettings,
} from './window';

const token = '0123456789abcdef0123456789abcdef';
const inputs = (platform: NodeJS.Platform, claude: string, home: string) => ({
  agentId: 'bob-agent',
  claude,
  files: windowFiles(home, platform),
  token,
  testCommands: ['pnpm check'],
  ownBranchPrefix: 'agent/bob/' as string | null,
  integrationBranch: 'agents',
});

describe('windowSettings', () => {
  it('has the guarded shape', () => {
    const i = inputs('linux', '/usr/bin/claude', '/home/bob');
    expect(windowSettings(i)).toEqual({
      env: {
        AGENTMESH_MESH_WINDOW: token,
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: i.files.emptyHooks,
        GIT_CONFIG_KEY_1: 'core.fsmonitor',
        GIT_CONFIG_VALUE_1: 'false',
        GIT_CONFIG_KEY_2: 'safe.bareRepository',
        GIT_CONFIG_VALUE_2: 'explicit',
      },
      disableAllHooks: false,
      permissions: {
        defaultMode: 'default',
        disableBypassPermissionsMode: 'disable',
        disableAutoMode: 'disable',
        allow: [
          'Edit(**/.claude/worktrees/mesh-*/**)',
          'Bash(git status)',
          'Bash(git fetch origin)',
          'Bash(git worktree add .claude/worktrees/mesh-*)',
          'Bash(git worktree remove .claude/worktrees/mesh-*)',
          'Bash(pnpm check)',
          'Bash(git add *)',
          'Bash(git commit -m *)',
          'Bash(git push origin agent/bob/*)',
          'Bash(git push -u origin agent/bob/*)',
          'Bash(gh pr create --base agents *)',
        ],
      },
    });
  });

  it('leaves out the push rules when there is no own branch prefix', () => {
    const i = { ...inputs('linux', '/c', '/h'), ownBranchPrefix: null };
    const allow = (windowSettings(i).permissions as { allow: string[] }).allow;
    expect(allow.some((r) => r.startsWith('Bash(git push'))).toBe(false);
    expect(allow).toContain('Bash(gh pr create --base agents *)');
  });
});

describe('launcherScript', () => {
  it('writes the windows launcher', () => {
    const i = inputs('win32', 'C:\\bin\\claude.cmd', 'C:\\Users\\bob');
    expect(launcherScript(i, 'win32')).toBe(
      [
        '@echo off',
        'setlocal',
        'set "NoDefaultCurrentDirectoryInExePath=1"',
        `set "AGENTMESH_MESH_WINDOW=${token}"`,
        'set "CLAUDE_CONFIG_DIR="',
        'if not "%~1"=="" cd /d "%~1" || exit /b 1',
        `call "C:\\bin\\claude.cmd" ${CHANNEL_FLAG} -n "mesh-bob-agent" --permission-mode default --settings "${i.files.settings}" "${LAUNCH_PROMPT}"`,
        '',
      ].join('\r\n'),
    );
  });

  it('leaves out the prompt when there is none', () => {
    const w = launcherScript(inputs('win32', 'C:\\c.cmd', 'C:\\h'), 'win32', null).split('\r\n');
    expect(w[6]).toMatch(/^call "C:\\c\.cmd" .* --settings "[^"]*"$/);
    const p = launcherScript(inputs('linux', '/c', '/h'), 'linux', null).split('\n');
    expect(p[4]).toMatch(/^exec '\/c' .* --settings '[^']*'$/);
  });

  it('writes paths below %USERPROFILE% as %USERPROFILE%\\… on windows, so cmd reads them in any code page', () => {
    const home = 'C:\\Users\\hömé';
    const i = { ...inputs('win32', `${home}\\.local\\bin\\claude.exe`, home), userProfile: home };
    const lines = launcherScript(i, 'win32').split('\r\n');
    expect(lines[6]).toBe(
      `call "%USERPROFILE%\\.local\\bin\\claude.exe" ${CHANNEL_FLAG} -n "mesh-bob-agent" --permission-mode default --settings "%USERPROFILE%\\.agentmesh\\mesh-window.settings.json" "${LAUNCH_PROMPT}"`,
    );
    expect(launcherScript(i, 'win32')).toMatch(/^[\x20-\x7e\r\n]*$/);
  });

  it('starts Claude Code in the account CLAUDE_CONFIG_DIR named', () => {
    const home = 'C:\\Users\\bob';
    const w = { ...inputs('win32', 'C:\\c.cmd', home), userProfile: home };
    const win = launcherScript({ ...w, configDir: `${home}\\.claude-work` }, 'win32').split('\r\n');
    expect(win.slice(3, 6)).toEqual([
      `set "AGENTMESH_MESH_WINDOW=${token}"`,
      'set "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-work"',
      'if not "%~1"=="" cd /d "%~1" || exit /b 1',
    ]);
    const p = { ...inputs('linux', '/c', '/home/bob'), configDir: '/home/bob/.claude-work' };
    expect(launcherScript(p, 'linux').split('\n')[2]).toBe(
      "export CLAUDE_CONFIG_DIR='/home/bob/.claude-work'",
    );
  });

  // window init printed "your default Claude account"; a terminal that has another set must not win.
  it('clears an inherited CLAUDE_CONFIG_DIR when none is baked, on windows', () => {
    const win = launcherScript(inputs('win32', 'C:\\c.cmd', 'C:\\h'), 'win32').split('\r\n');
    expect(win[4]).toBe('set "CLAUDE_CONFIG_DIR="');
    expect(win.filter((l) => l.includes('CLAUDE_CONFIG_DIR'))).toHaveLength(1);
  });

  it('clears an inherited CLAUDE_CONFIG_DIR when none is baked, on posix', () => {
    const p = launcherScript(inputs('linux', '/c', '/h'), 'linux').split('\n');
    expect(p[2]).toBe('unset CLAUDE_CONFIG_DIR');
    expect(p.filter((l) => l.includes('CLAUDE_CONFIG_DIR'))).toHaveLength(1);
  });

  it('writes the posix launcher', () => {
    const i = inputs('linux', '/usr/bin/claude', '/home/bob');
    expect(launcherScript(i, 'linux')).toBe(
      [
        '#!/bin/sh',
        `export AGENTMESH_MESH_WINDOW='${token}'`,
        'unset CLAUDE_CONFIG_DIR',
        'if [ -n "$1" ]; then cd -- "$1" || exit 1; fi',
        `exec '/usr/bin/claude' ${CHANNEL_FLAG} -n 'mesh-bob-agent' --permission-mode default --settings '${i.files.settings}' '${LAUNCH_PROMPT}'`,
        '',
      ].join('\n'),
    );
  });
});

describe('bakeable', () => {
  it('refuses characters a script would misread', () => {
    expect(bakeable('C:/Users/R&D/.agentmesh/x', 'win32')).toBe(false);
    expect(bakeable('C:/a%b', 'win32')).toBe(false);
    expect(bakeable('C:/a"b', 'win32')).toBe(false);
    expect(bakeable("/home/o'b", 'linux')).toBe(false);
    expect(bakeable('/home/a\nb', 'linux')).toBe(false);
    expect(bakeable('C:/Users/ok/x', 'win32')).toBe(true);
    expect(bakeable('/home/o b', 'linux')).toBe(true);
  });

  it('refuses non-ASCII left in a windows path once %USERPROFILE% stands in for the home', () => {
    const home = 'C:\\Users\\hömé';
    expect(bakeable(`${home}\\.agentmesh\\x`, 'win32', home)).toBe(true);
    expect(bakeable(`${home}\\.agentmesh\\x`, 'win32', null)).toBe(false);
    expect(bakeable('D:\\tööls\\claude.cmd', 'win32', home)).toBe(false);
    expect(bakeable('/home/hömé/x', 'linux', null)).toBe(true);
  });

  it('checks the expanded path for what call re-expands', () => {
    // `call` expands %USERPROFILE% again and doubles carets, so its value must be plain too.
    expect(bakeable('C:\\Users\\a%b\\x', 'win32', 'C:\\Users\\a%b')).toBe(false);
    expect(bakeable('C:\\Users\\a^b\\x', 'win32', 'C:\\Users\\a^b')).toBe(false);
  });
});

describe('bakedPath', () => {
  it('replaces the user profile folder, in any case, only on windows', () => {
    expect(bakedPath('c:\\users\\bob\\x', 'win32', 'C:\\Users\\Bob')).toBe('%USERPROFILE%\\x');
    expect(bakedPath('C:\\Users\\Bobby\\x', 'win32', 'C:\\Users\\Bob')).toBe('C:\\Users\\Bobby\\x');
    expect(bakedPath('/home/bob/x', 'linux', '/home/bob')).toBe('/home/bob/x');
  });
});

describe('shimScripts', () => {
  it('writes claude-mesh on posix: the marker, then exec of the launcher', () => {
    expect(shimScripts('/home/bob/.agentmesh/mesh-window', 'linux')).toEqual([
      {
        name: 'claude-mesh',
        content:
          '#!/bin/sh\n# agentmesh claude-mesh\nexec \'/home/bob/.agentmesh/mesh-window\' "$@"\n',
      },
    ]);
  });

  it('writes an ASCII claude-mesh.cmd on windows, and a sh claude-mesh for Git Bash', () => {
    // Git Bash finds no .cmd by its bare name, so the sh one runs the .cmd beside it.
    const home = 'C:\\Users\\hömé';
    const scripts = shimScripts(`${home}\\.agentmesh\\mesh-window.cmd`, 'win32', home);
    expect(scripts).toEqual([
      {
        name: 'claude-mesh.cmd',
        // No `call`: it would expand % again and double ^ in the folder argument. As the last
        // line, control passes to the launcher and its exit code comes back.
        content:
          '@echo off\r\nrem agentmesh claude-mesh\r\n"%USERPROFILE%\\.agentmesh\\mesh-window.cmd" %*\r\n',
      },
      {
        name: 'claude-mesh',
        // Git Bash hands cmd two quoted strings when this script's own path has a space, so the
        // folder is entered here and the .cmd gets no argument. $0 is resolved before the cd, so
        // a claude-mesh.cmd in the target folder is never the one run.
        content: [
          '#!/bin/sh',
          '# agentmesh claude-mesh',
          'self=$0; case $self in /*) ;; *) self=$PWD/$self ;; esac',
          'if [ -n "$1" ]; then cd -- "$1" || exit 1; fi',
          'exec "$self.cmd"',
          '',
        ].join('\n'),
      },
    ]);
    for (const s of scripts) expect(s.content).toMatch(/^[\x20-\x7e\r\n]*$/);
  });

  it('knows its own files by the marker line', () => {
    const ours = [...shimScripts('/x', 'linux'), ...shimScripts('C:\\x.cmd', 'win32')];
    for (const s of ours) expect(isOurShim(s.content)).toBe(true);
    expect(isOurShim('@echo off\r\ncall "C:\\other.exe" %*\r\n')).toBe(false);
    expect(isOurShim('#!/bin/sh\n# not agentmesh claude-mesh\n')).toBe(false);
  });
});

describe('sessionName', () => {
  it('is at most 64 characters', () => {
    expect(sessionName('a'.repeat(63)).length).toBe(64);
    expect(sessionName('bob-agent')).toBe('mesh-bob-agent');
  });
});
