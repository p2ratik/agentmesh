// Pure: which shell startup files could define a claude-mesh that runs instead of the launcher,
// and which lines of one do. No I/O: the reader is `shell-shadow-scan.ts`.
import { join } from 'node:path';
import { START_COMMAND } from '@agentmesh/common/window';

const NAME = START_COMMAND;
const END = '(?![\\w-])';
const QUOTE = `['"]?`;

// function claude-mesh (PowerShell also function global:claude-mesh). PowerShell names are
// case-insensitive; bash, zsh and fish are not.
const FUNCTION = `^\\s*function\\s+(?:\\w+:)?${QUOTE}${NAME}${END}`;
const FUNCTION_EXACT = new RegExp(FUNCTION);
const FUNCTION_ANY_CASE = new RegExp(FUNCTION, 'i');
const ALIAS_CMDLET = '(?:set-alias|new-alias|sal|nal)';

const PATTERNS: RegExp[] = [
  // PowerShell: Set-Alias / New-Alias (or sal / nal) with the name first or as -Name
  new RegExp(`^\\s*${ALIAS_CMDLET}\\s+${QUOTE}${NAME}${END}`, 'i'),
  new RegExp(`^\\s*${ALIAS_CMDLET}\\b.*\\s-name[\\s:]+${QUOTE}${NAME}${END}`, 'i'),
  // sh, bash, zsh: alias claude-mesh=...; fish: alias claude-mesh ...
  new RegExp(`^\\s*alias\\s+(?:-\\w+\\s+)*${QUOTE}${NAME}${END}`),
  // sh, bash, zsh: claude-mesh() { ... }
  new RegExp(`^\\s*${NAME}\\s*\\(\\s*\\)`),
];

/**
 * The 1-based numbers of the lines that define claude-mesh as a function or alias. Commented
 * lines never match, because every pattern starts at the line's first word. `powershell` makes
 * the function name case-insensitive.
 */
export function shadowLines(text: string, powershell = false): number[] {
  const fn = powershell ? FUNCTION_ANY_CASE : FUNCTION_EXACT;
  const hits: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (fn.test(line) || PATTERNS.some((p) => p.test(line))) hits.push(i + 1);
  });
  return hits;
}

const POWERSHELL_PROFILES = [
  ['WindowsPowerShell', 'profile.ps1'],
  ['WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'],
  ['WindowsPowerShell', 'Microsoft.VSCode_profile.ps1'],
  ['PowerShell', 'profile.ps1'],
  ['PowerShell', 'Microsoft.PowerShell_profile.ps1'],
  ['PowerShell', 'Microsoft.VSCode_profile.ps1'],
] as const;

/**
 * The startup files to read, whether or not they exist. PowerShell's are scanned on Windows only
 * (its Documents folder may live under OneDrive); the POSIX ones everywhere, because Git Bash on
 * Windows reads ~/.bashrc. `isFolder` says whether a Documents folder under OneDrive is there.
 */
export function startupFiles(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
  isFolder: (path: string) => boolean,
): string[] {
  const files: string[] = [];
  if (platform === 'win32') {
    const docs = new Set([join(env.USERPROFILE || home, 'Documents')]);
    for (const root of [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]) {
      if (root && isFolder(join(root, 'Documents'))) docs.add(join(root, 'Documents'));
    }
    for (const d of docs) for (const p of POWERSHELL_PROFILES) files.push(join(d, ...p));
  }
  for (const p of ['.bashrc', '.bash_profile', '.profile', '.bash_aliases', '.zshrc']) {
    files.push(join(home, p));
  }
  files.push(join(home, '.config', 'fish', 'config.fish'));
  return files;
}

/** Files whose mere existence defines claude-mesh: fish loads functions/claude-mesh.fish by name. */
export const definingFiles = (home: string): string[] => [
  join(home, '.config', 'fish', 'functions', `${START_COMMAND}.fish`),
];

/** One warning line for a hit; the file is printed as it is. */
export const shadowWarning = (file: string, line: number): string =>
  `Warning: ${file}:${line} defines ${START_COMMAND}, which runs instead of the launcher in that shell. Remove or rename it, then open a new terminal.`;
