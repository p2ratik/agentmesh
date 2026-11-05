import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shadowLines, startupFiles } from './shell-shadow';

describe('shadowLines', () => {
  it.each([
    'function claude-mesh { claude --dangerously-load-development-channels x }',
    'Function Claude-Mesh {',
    '  function global:claude-mesh() {',
    'Set-Alias claude-mesh C:\\x\\y.exe',
    'New-Alias -Name claude-mesh -Value claude',
    'set-alias -Value claude -Name "claude-mesh"',
    "alias claude-mesh='claude --x'",
    'claude-mesh() { claude "$@"; }',
    'claude-mesh ( ) { claude; }',
    'function claude-mesh() { claude; }',
    'alias claude-mesh claude',
    'function claude-mesh',
  ])('matches %s', (line) => {
    expect(shadowLines(line)).toEqual([1]);
  });

  it('gives 1-based line numbers, across CRLF too', () => {
    expect(shadowLines('a\r\nfunction claude-mesh {\r\nb\r\nalias claude-mesh=x')).toEqual([2, 4]);
  });

  it.each([
    '# function claude-mesh {',
    '   # alias claude-mesh=x',
    'function my-claude-mesh {',
    'function claude-meshy {',
    'alias my-claude-mesh=x',
    'alias claude-meshy=x',
    'my-claude-mesh() { x; }',
    'Set-Alias cm claude-mesh',
    'claude-mesh --help',
    'echo function claude-mesh',
    '',
  ])('ignores %s', (line) => {
    expect(shadowLines(line)).toEqual([]);
  });
});

describe('startupFiles', () => {
  const home = join('h', 'me');
  const posix = ['.bashrc', '.bash_profile', '.profile', '.zshrc'].map((f) => join(home, f));
  posix.push(join(home, '.config', 'fish', 'config.fish'));
  const ps = (docs: string) =>
    [
      ['WindowsPowerShell', 'profile.ps1'],
      ['WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'],
      ['PowerShell', 'profile.ps1'],
      ['PowerShell', 'Microsoft.PowerShell_profile.ps1'],
    ].map((p) => join(docs, ...p));

  it('lists only the POSIX files off Windows', () => {
    expect(startupFiles('linux', home, { USERPROFILE: 'x' }, () => true)).toEqual(posix);
  });

  it('lists the PowerShell profiles in Documents, then the POSIX ones, on Windows', () => {
    const files = startupFiles('win32', home, { USERPROFILE: home }, () => false);
    expect(files).toEqual([...ps(join(home, 'Documents')), ...posix]);
  });

  it('adds Documents under each OneDrive folder that is set and exists', () => {
    const env = {
      USERPROFILE: home,
      OneDrive: join('od', 'a'),
      OneDriveConsumer: join('od', 'b'),
      OneDriveCommercial: join('od', 'gone'),
    };
    const docs = (p: string) => p !== join('od', 'gone');
    expect(startupFiles('win32', home, env, docs)).toEqual([
      ...ps(join(home, 'Documents')),
      ...ps(join('od', 'a', 'Documents')),
      ...ps(join('od', 'b', 'Documents')),
      ...posix,
    ]);
  });

  it('skips a OneDrive folder without a Documents folder, and repeats nothing', () => {
    const env = { USERPROFILE: home, OneDrive: home, OneDriveConsumer: join('od', 'c') };
    const files = startupFiles('win32', home, env, (p) => p === join('od', 'c'));
    expect(files).toEqual([...ps(join(home, 'Documents')), ...posix]);
  });
});
