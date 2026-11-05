import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_SESSION_SLACK_MS,
  claudeSessionFile,
  deleteClaudeSession,
  pruneClaudeSessions,
  readClaudeSession,
  writeClaudeSession,
} from './claude-session';

const UUID = '0b6c1a52-3e9f-4d2a-9c11-5f2e8a7d4b10';
const NOW = new Date('2026-11-05T10:00:00.000Z');
const input = { session_id: UUID, source: 'startup' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'am-claude-session-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the conversation record', () => {
  it('writes, reads and deletes the record of a Claude Code process', () => {
    writeClaudeSession(dir, '4242', input, NOW);
    const file = join(dir, 'cc-4242.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...input, at: NOW.toISOString() });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readClaudeSession(dir, 4242, NOW.getTime())).toBe(UUID);
    expect(readClaudeSession(dir, 4243, NOW.getTime())).toBeNull();
    deleteClaudeSession(dir, '4242');
    expect(readdirSync(dir)).toEqual([]);
    expect(readClaudeSession(dir, 4242, NOW.getTime())).toBeNull();
    deleteClaudeSession(dir, '4242');
  });

  it('writes nothing for a bad process id or conversation id', () => {
    for (const pid of [undefined, '', 'abc', '12345678901', '../1', '1/2', -1, 1.5]) {
      expect(claudeSessionFile(pid)).toBeNull();
      writeClaudeSession(dir, pid, input, NOW);
    }
    for (const id of [undefined, 'not-a-uuid', UUID.toUpperCase(), `${UUID}\n`, 42]) {
      writeClaudeSession(dir, '4242', { session_id: id, source: 'startup' }, NOW);
    }
    expect(readdirSync(dir)).toEqual([]);
    expect([claudeSessionFile(4242), claudeSessionFile('7')]).toEqual([
      'cc-4242.json',
      'cc-7.json',
    ]);
  });

  it('reads no id that is not a UUID', () => {
    const at = NOW.toISOString();
    for (const body of ['{', 'null', JSON.stringify({ session_id: '../x', at })]) {
      writeFileSync(join(dir, 'cc-4242.json'), body);
      expect(readClaudeSession(dir, 4242, NOW.getTime())).toBeNull();
    }
  });

  // Review Focus 5: Windows reuses process ids, so an old record must not name this session.
  it('refuses a record written long before the server started', () => {
    expect(CLAUDE_SESSION_SLACK_MS).toBe(60_000);
    const startedAt = NOW.getTime();
    writeClaudeSession(dir, 4242, input, new Date(startedAt - 61_000));
    expect(readClaudeSession(dir, 4242, startedAt)).toBeNull();
    writeClaudeSession(dir, 4242, input, new Date(startedAt - 59_000));
    expect(readClaudeSession(dir, 4242, startedAt)).toBe(UUID);
  });

  it('prunes records older than a day, and nothing else', () => {
    const old = new Date(NOW.getTime() - 25 * 3600_000);
    for (const name of ['cc-1.json', 'cc-2.json.tmp', 'cc-3.json', 'sess-x.json']) {
      writeFileSync(join(dir, name), '{}');
      utimesSync(join(dir, name), old, old);
    }
    utimesSync(join(dir, 'cc-3.json'), NOW, NOW);
    pruneClaudeSessions(dir, NOW.getTime());
    expect(readdirSync(dir).sort()).toEqual(['cc-3.json', 'sess-x.json']);
    pruneClaudeSessions(join(dir, 'missing'), NOW.getTime());
  });
});
