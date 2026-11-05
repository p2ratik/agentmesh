import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../context';
import { shellShadowWarnings } from './shell-shadow-scan';

const ctxFor = (home: string): CliContext => ({
  cwd: home,
  env: { USERPROFILE: home },
  homeDir: home,
  stdout: () => undefined,
  stderr: () => undefined,
});
const temp = () => mkdtempSync(join(tmpdir(), 'am-shadow-'));
const put = (file: string, content: string | Buffer) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
};
const warning = (file: string, line: number) =>
  `Warning: ${file}:${line} defines claude-mesh, which runs instead of the launcher in that shell. Remove or rename it, then open a new terminal.`;

describe('shellShadowWarnings', () => {
  it('reads PowerShell profiles on win32, wherever the test runs', () => {
    const home = temp();
    const profile = join(
      home,
      'Documents',
      'WindowsPowerShell',
      'Microsoft.PowerShell_profile.ps1',
    );
    put(profile, 'Set-Location ~\r\nfunction Claude-Mesh { claude }\r\n');
    expect(shellShadowWarnings(ctxFor(home), 'win32')).toEqual([warning(profile, 2)]);
    expect(shellShadowWarnings(ctxFor(home), 'linux')).toEqual([]);
  });

  it('reads a UTF-16LE profile with a BOM, as Windows PowerShell 5.1 writes it', () => {
    const home = temp();
    const profile = join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1');
    const text = 'Set-Location ~\r\nfunction claude-mesh { claude }\r\n';
    put(profile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    expect(shellShadowWarnings(ctxFor(home), 'win32')).toEqual([warning(profile, 2)]);
  });

  it('warns once for the fish function file, whatever it holds', () => {
    const home = temp();
    const file = join(home, '.config', 'fish', 'functions', 'claude-mesh.fish');
    put(file, 'claude $argv\n');
    expect(shellShadowWarnings(ctxFor(home), 'linux')).toEqual([warning(file, 1)]);
  });

  it('warns about ~/.bash_aliases and is quiet for a clean home', () => {
    const home = temp();
    expect(shellShadowWarnings(ctxFor(home), 'linux')).toEqual([]);
    const file = join(home, '.bash_aliases');
    put(file, 'alias ll=ls\nalias claude-mesh=claude\n');
    expect(shellShadowWarnings(ctxFor(home), 'linux')).toEqual([warning(file, 2)]);
  });
});
