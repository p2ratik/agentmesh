import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sshProgram } from './remote';

describe('sshProgram', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-systemroot-'));
  const openssh = join(root, 'System32', 'OpenSSH');
  mkdirSync(openssh, { recursive: true });
  writeFileSync(join(openssh, 'ssh.exe'), '');

  it('on Windows, the system OpenSSH when it is installed', () => {
    const windows = { platform: 'win32' as const, env: { SystemRoot: root } };
    expect(sshProgram('ssh', windows)).toBe(join(openssh, 'ssh.exe'));
    // No scp.exe there: the one on PATH.
    expect(sshProgram('scp', windows)).toBe('scp');
  });

  it('elsewhere, or with no platform given, the one on PATH', () => {
    expect(sshProgram('ssh', { platform: 'linux', env: { SystemRoot: root } })).toBe('ssh');
    expect(sshProgram('ssh', { env: { SystemRoot: root } })).toBe('ssh');
    expect(sshProgram('ssh', { platform: 'win32', env: {} })).toBe('ssh');
  });
});
