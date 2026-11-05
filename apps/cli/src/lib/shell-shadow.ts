// Pure: which shell startup files could define a claude-mesh that runs instead of the launcher,
// and which lines of one do. No I/O: the reader is `shell-shadow-scan.ts`.
import { join } from 'node:path';
import { START_COMMAND } from '@agentmesh/common/window';

const NAME = START_COMMAND.replace(/[-]/g, '\\-');
const END = '(?![\\w-])';
const QUOTE = `['"]?`;

const PATTERNS: RegExp[] = [
  // PowerShell, sh, bash, zsh and fish: function claude-mesh (PowerShell also function global:claude-mesh)
  new RegExp(`^\\s*function\\s+(?:\\w+:)?${QUOTE}${NAME}${END}`, 'i'),
  // PowerShell: Set-Alias / New-Alias with the name first or as -Name
  new RegExp(`^\\s*(?:set|new)-alias\\s+(?:-name[\\s:]+)?${QUOTE}${NAME}${END}`, 'i'),
  new RegExp(`^\\s*(?:set|new)-alias\\b.*\\s-name[\\s:]+${QUOTE}${NAME}${END}`, 'i'),
  // sh, bash, zsh: alias claude-mesh=…; fish: alias claude-mesh …
  new RegExp(`^\\s*alias\\s+(?:-\\w+\\s+)*${QUOTE}${NAME}${END}`),
  // sh, bash, zsh: claude-mesh() { … }
  new RegExp(`^\\s*${NAME}\\s*\\(\\s*\\)`),
];

/** The 1-based numbers of the lines that define claude-mesh as a function or alias. */
export function shadowLines(text: string): number[] {
  const hits: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (PATTERNS.some((p) => p.test(line))) hits.push(i + 1);
  });
  return hits;
}

const POWERSHELL_PROFILES = [
  ['WindowsPowerShell', 'profile.ps1'],
  ['WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'],
  ['PowerShell', 'profile.ps1'],
  ['PowerShell', 'Microsoft.PowerShell_profile.ps1'],
] as const;

/**
 * The startup files to read, whether or not they exist. PowerShell's are scanned on Windows only
 * (its Documents folder may live under OneDrive); the POSIX ones everywhere, because Git Bash on
 * Windows reads ~/.bashrc. `isFolder` says whether a OneDrive folder is there.
 */
export function startupFiles(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
  isFolder: (path: string) => boolean,
): string[] {
  const files: string[] = [];
  if (platform === 'win32') {
    const roots = [
      env.USERPROFILE || home,
      env.OneDrive,
      env.OneDriveConsumer,
      env.OneDriveCommercial,
    ];
    const docs = new Set<string>();
    roots.forEach((root, i) => {
      if (!root) return;
      if (i > 0 && !isFolder(root)) return;
      const d = join(root, 'Documents');
      if (i === 0 || isFolder(d)) docs.add(d);
    });
    for (const d of docs) for (const p of POWERSHELL_PROFILES) files.push(join(d, ...p));
  }
  for (const p of ['.bashrc', '.bash_profile', '.profile', '.zshrc']) files.push(join(home, p));
  files.push(join(home, '.config', 'fish', 'config.fish'));
  return files;
}

/** One warning line for a hit; the file is printed as it is. */
export const shadowWarning = (file: string, line: number): string =>
  `Warning: ${file}:${line} defines ${START_COMMAND}, which runs instead of the launcher in that shell. Remove or rename it, then open a new terminal.`;
