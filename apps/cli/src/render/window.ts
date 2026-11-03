import {
  CHANNEL_FLAG,
  LAUNCH_PROMPT,
  START_COMMAND,
  type WindowFiles,
} from '@agentmesh/common/window';

export interface WindowInputs {
  agentId: string;
  claude: string;
  files: WindowFiles;
  token: string;
  testCommands: string[];
  ownBranchPrefix: string | null;
  integrationBranch: string;
  /** %USERPROFILE% as `window init` saw it; the Windows launcher writes paths below it that way. */
  userProfile?: string | null;
  /** CLAUDE_CONFIG_DIR as `window init` saw it: the Claude account the window starts in. */
  configDir?: string | null;
}

export const sessionName = (agentId: string): string => `mesh-${agentId}`.slice(0, 64);

/**
 * A path as the launcher writes it. cmd reads a .cmd file in the console's code page, not UTF-8,
 * so on Windows a path below the user profile is written `%USERPROFILE%\…` and a non-ASCII user
 * folder still works.
 */
export function bakedPath(
  path: string,
  platform: NodeJS.Platform,
  userProfile: string | null = null,
): string {
  if (platform !== 'win32' || !userProfile) return path;
  const home = userProfile.replace(/\\+$/, '');
  const below = path.toUpperCase().startsWith(`${home.toUpperCase()}\\`);
  return below ? `%USERPROFILE%${path.slice(home.length)}` : path;
}

/**
 * Whether a path can be baked inside quotes in the launcher without being reinterpreted. On
 * Windows the expanded path is checked (`call` expands `%` again and doubles `^`), and what is
 * written must be ASCII.
 */
export function bakeable(
  path: string,
  platform: NodeJS.Platform,
  userProfile: string | null = null,
): boolean {
  if (/[\r\n]/.test(path)) return false;
  if (platform !== 'win32') return !path.includes("'");
  return !/[%^&"!<>|]/.test(path) && /^[\x20-\x7e]*$/.test(bakedPath(path, platform, userProfile));
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
export function launcherScript(
  i: WindowInputs,
  platform: NodeJS.Platform,
  prompt: string | null = LAUNCH_PROMPT,
): string {
  const win = platform === 'win32';
  const q = (s: string) => (win ? `"${s}"` : `'${s}'`);
  const at = (p: string) => bakedPath(p, platform, i.userProfile);
  const claude = [
    q(at(i.claude)),
    CHANNEL_FLAG,
    '-n',
    q(sessionName(i.agentId)),
    '--permission-mode default --settings',
    q(at(i.files.settings)),
    ...(prompt === null ? [] : [q(prompt)]),
  ].join(' ');
  // No account baked: clear one the terminal has, so the window starts the default account.
  const account = i.configDir ?? null;
  const lines = win
    ? [
        '@echo off',
        'setlocal',
        'set "NoDefaultCurrentDirectoryInExePath=1"',
        `set "AGENTMESH_MESH_WINDOW=${i.token}"`,
        `set "CLAUDE_CONFIG_DIR=${account ? at(account) : ''}"`,
        'if not "%~1"=="" cd /d "%~1" || exit /b 1',
        `call ${claude}`,
      ]
    : [
        '#!/bin/sh',
        `export AGENTMESH_MESH_WINDOW='${i.token}'`,
        account ? `export CLAUDE_CONFIG_DIR='${account}'` : 'unset CLAUDE_CONFIG_DIR',
        'if [ -n "$1" ]; then cd -- "$1" || exit 1; fi',
        `exec ${claude}`,
      ];
  return `${lines.join(win ? '\r\n' : '\n')}${win ? '\r\n' : '\n'}`;
}

/** The marker line's text: a `claude-mesh` file that carries it was written by `window init`. */
const SHIM_MARK = `agentmesh ${START_COMMAND}`;

export const isOurShim = (text: string): boolean =>
  text.split(/\r?\n/).some((l) => l === `rem ${SHIM_MARK}` || l === `# ${SHIM_MARK}`);

/**
 * `claude-mesh`, which only forwards to the launcher, so the launcher's checks all still hold.
 * Windows gets a `.cmd` for cmd and PowerShell, and a sh script for Git Bash, which finds no `.cmd`
 * by its bare name; it runs the `.cmd` beside it (`$0` is its own path). The `.cmd` runs the
 * launcher without `call`, which would expand `%` again and double `^` in the folder argument; as
 * the last line, control passes to the launcher and its exit code comes back.
 */
export function shimScripts(
  launcher: string,
  platform: NodeJS.Platform,
  userProfile: string | null = null,
): { name: string; content: string }[] {
  const sh = (target: string) => `#!/bin/sh\n# ${SHIM_MARK}\nexec ${target} "$@"\n`;
  if (platform !== 'win32') return [{ name: START_COMMAND, content: sh(`'${launcher}'`) }];
  const run = `"${bakedPath(launcher, platform, userProfile)}" %*`;
  return [
    {
      name: `${START_COMMAND}.cmd`,
      content: ['@echo off', `rem ${SHIM_MARK}`, run, ''].join('\r\n'),
    },
    { name: START_COMMAND, content: sh('"$0.cmd"') },
  ];
}
