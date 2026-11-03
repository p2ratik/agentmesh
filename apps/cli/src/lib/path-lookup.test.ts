import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findOnPath } from './path-lookup';

describe('findOnPath', () => {
  it('finds claude on PATH and never in the current folder', () => {
    const want = join('C:\\bin', 'claude.cmd');
    const seen: string[] = [];
    const isFile = (p: string) => {
      seen.push(p);
      return p === want;
    };
    expect(findOnPath('claude', { PATH: '.;relative;C:\\bin' }, 'win32', isFile)).toBe(want);
    expect(seen.every((p) => p.startsWith('C:'))).toBe(true);
  });

  it('prefers .exe over .cmd', () => {
    const both = new Set([join('C:\\bin', 'claude.cmd'), join('C:\\bin', 'claude.exe')]);
    expect(findOnPath('claude', { PATH: 'C:\\bin' }, 'win32', (p) => both.has(p))).toBe(
      join('C:\\bin', 'claude.exe'),
    );
  });

  it('finds an extension-less file on linux', () => {
    const want = join('/opt/x', 'claude');
    expect(findOnPath('claude', { PATH: '/usr/bin:/opt/x' }, 'linux', (p) => p === want)).toBe(
      want,
    );
  });

  it('returns null when nothing is found', () => {
    expect(findOnPath('claude', { PATH: '/usr/bin' }, 'linux', () => false)).toBeNull();
    expect(findOnPath('claude', {}, 'linux', () => true)).toBeNull();
  });
});
