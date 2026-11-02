import { CHANNEL_FLAG, LAUNCH_PROMPT, windowFiles } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import { bakeable, launcherScript, sessionName, windowSettings } from './window';

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
        'if not "%~1"=="" cd /d "%~1" || exit /b 1',
        `"C:\\bin\\claude.cmd" ${CHANNEL_FLAG} -n "mesh-bob-agent" --permission-mode default --settings "${i.files.settings}" "${LAUNCH_PROMPT}"`,
        '',
      ].join('\r\n'),
    );
  });

  it('writes the posix launcher', () => {
    const i = inputs('linux', '/usr/bin/claude', '/home/bob');
    expect(launcherScript(i, 'linux')).toBe(
      [
        '#!/bin/sh',
        `export AGENTMESH_MESH_WINDOW='${token}'`,
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
});

describe('sessionName', () => {
  it('is at most 64 characters', () => {
    expect(sessionName('a'.repeat(63)).length).toBe(64);
    expect(sessionName('bob-agent')).toBe('mesh-bob-agent');
  });
});
