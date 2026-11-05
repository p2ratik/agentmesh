import { describe, expect, it } from 'vitest';
import { maskSocket, parentVerdict } from '../scripts/probe-messaging.mjs';

describe('maskSocket', () => {
  it('swaps the home prefix for ~ and masks the random part', () => {
    expect(
      maskSocket('/home/bob/.claude/run/cc-msg-0123456789abcdef0123456789abcdef.sock', '/home/bob'),
    ).toBe('~/.claude/run/cc-msg-<32 hex>.sock');
  });

  it('masks a Windows pipe name', () => {
    expect(maskSocket(`\\\\.\\pipe\\LOCAL\\cc-msg-${'a'.repeat(32)}`, 'C:\\Users\\x')).toBe(
      '\\\\.\\pipe\\LOCAL\\cc-msg-<32 hex>',
    );
  });

  it('keeps the path absolute when the home prefix does not match', () => {
    expect(maskSocket('/tmp/other/cc-msg-0123456789abcdef.sock', '/home/bob')).toBe(
      '/tmp/other/cc-msg-<16 hex>.sock',
    );
  });

  it('does not treat a sibling folder as the home prefix', () => {
    expect(maskSocket('/home/bobx/run/a.sock', '/home/bob')).toBe('/home/bobx/run/a.sock');
  });

  it('masks an exact home match', () => {
    expect(maskSocket('/home/bob', '/home/bob')).toBe('~');
  });

  it('leaves a run of 7 hex digits alone', () => {
    expect(maskSocket('/home/bob/x/abcdef0.sock', '/home/bob')).toBe('~/x/abcdef0.sock');
  });
});

describe('parentVerdict', () => {
  it('says the pid matches', () => {
    expect(parentVerdict(10, 10, 'claude')).toBe(
      'MCP server parent: claude (pid matches the claude process this probe started)',
    );
  });

  it('says unknown and does not match', () => {
    expect(parentVerdict(11, 10, null)).toBe(
      'MCP server parent: unknown (pid does not match the claude process this probe started)',
    );
  });
});
