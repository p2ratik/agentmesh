import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  freshGuardStamp,
  GUARD_STAMP,
  GUARD_STAMP_MAX_AGE_MS,
  writeGuardStamp,
} from './guard-stamp';

let base: string;
let dir: string;
const now = new Date('2026-11-03T10:00:00Z');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'am-stamp-'));
  dir = join(base, 'data', 'agentmesh');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the guard stamp', () => {
  it('is alive right after the guard writes it, for two minutes', () => {
    expect(GUARD_STAMP_MAX_AGE_MS).toBe(120_000);
    writeGuardStamp(dir, now, '0.6.0');
    expect(readdirSync(dir)).toEqual([GUARD_STAMP]);
    expect(freshGuardStamp(dir, now.getTime())).not.toBeNull();
    expect(freshGuardStamp(dir, now.getTime() + 119_000)).not.toBeNull();
    expect(freshGuardStamp(dir, now.getTime() + 121_000)).toBeNull();
    expect(freshGuardStamp(dir, now.getTime() - 1_000)).toBeNull();
  });

  it('is dead with no file or a corrupt one', () => {
    expect(freshGuardStamp(dir, now.getTime())).toBeNull();
    writeGuardStamp(dir, now, '0.6.0');
    for (const text of ['', '{', 'null', '{"at":5}', '{"at":"soon"}']) {
      writeFileSync(join(dir, GUARD_STAMP), text);
      expect(freshGuardStamp(dir, now.getTime())).toBeNull();
    }
  });

  it('stamps the guard version and reads it only while fresh', () => {
    writeGuardStamp(dir, now, '0.6.0');
    expect(freshGuardStamp(dir, now.getTime() + 1_000)).toEqual({ version: '0.6.0' });
    expect(freshGuardStamp(dir, now.getTime() + 121_000)).toBeNull();
    // A stamp from a guard before 0.6.0 has no version: alive, but no version to read.
    writeFileSync(join(dir, GUARD_STAMP), JSON.stringify({ at: now.toISOString() }));
    expect(freshGuardStamp(dir, now.getTime() + 1_000)).toEqual({ version: null });
    rmSync(join(dir, GUARD_STAMP));
    expect(freshGuardStamp(dir, now.getTime())).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('is private to the user', () => {
    writeGuardStamp(dir, now, '0.6.0');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, GUARD_STAMP)).mode & 0o777).toBe(0o600);
  });
});
