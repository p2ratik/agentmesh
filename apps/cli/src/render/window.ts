import { CHANNEL_FLAG, LAUNCH_PROMPT, type WindowFiles } from '@agentmesh/common/window';

export interface WindowInputs {
  agentId: string;
  claude: string;
  files: WindowFiles;
  token: string;
  testCommands: string[];
  ownBranchPrefix: string | null;
  integrationBranch: string;
}

export const sessionName = (agentId: string): string => `mesh-${agentId}`.slice(0, 64);

/** Whether a path can be baked inside quotes in the launcher without being reinterpreted. */
export function bakeable(path: string, platform: NodeJS.Platform): boolean {
  if (/[\r\n]/.test(path)) return false;
  return platform === 'win32' ? !/[%^&"!<>|]/.test(path) : !path.includes("'");
}

export function windowSettings(i: WindowInputs): Record<string, unknown> {
  const push = i.ownBranchPrefix
    ? [
        `Bash(git push origin ${i.ownBranchPrefix}*)`,
        `Bash(git push -u origin ${i.ownBranchPrefix}*)`,
      ]
    : [];
  return {
    env: {
      AGENTMESH_MESH_WINDOW: i.token,
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
        ...i.testCommands.map((c) => `Bash(${c})`),
        'Bash(git add *)',
        'Bash(git commit -m *)',
        ...push,
        `Bash(gh pr create --base ${i.integrationBranch} *)`,
      ],
    },
  };
}

/** The launcher: marks the window with the token, enters the folder, starts Claude Code. */
export function launcherScript(i: WindowInputs, platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  const q = (s: string) => (win ? `"${s}"` : `'${s}'`);
  const claude = [
    q(i.claude),
    CHANNEL_FLAG,
    '-n',
    q(sessionName(i.agentId)),
    '--permission-mode default --settings',
    q(i.files.settings),
    ...(LAUNCH_PROMPT === null ? [] : [q(LAUNCH_PROMPT)]),
  ].join(' ');
  const lines = win
    ? [
        '@echo off',
        'setlocal',
        'set "NoDefaultCurrentDirectoryInExePath=1"',
        `set "AGENTMESH_MESH_WINDOW=${i.token}"`,
        'if not "%~1"=="" cd /d "%~1" || exit /b 1',
        claude,
      ]
    : [
        '#!/bin/sh',
        `export AGENTMESH_MESH_WINDOW='${i.token}'`,
        'if [ -n "$1" ]; then cd -- "$1" || exit 1; fi',
        `exec ${claude}`,
      ];
  return `${lines.join(win ? '\r\n' : '\n')}${win ? '\r\n' : '\n'}`;
}
