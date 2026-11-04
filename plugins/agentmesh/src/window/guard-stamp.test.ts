import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GUARD_STAMP,
  GUARD_STAMP_MAX_AGE_MS,
  guardAlive,
  guardVersion,
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
    expect(guardAlive(dir, now.getTime())).toBe(true);
    expect(guardAlive(dir, now.getTime() + 119_000)).toBe(true);
    expect(guardAlive(dir, now.getTime() + 121_000)).toBe(false);
    expect(guardAlive(dir, now.getTime() - 1_000)).toBe(false);
  });

  it('is dead with no file or a corrupt one', () => {
    expect(guardAlive(dir, now.getTime())).toBe(false);
    writeGuardStamp(dir, now, '0.6.0');
    for (const text of ['', '{', 'null', '{"at":5}', '{"at":"soon"}']) {
      writeFileSync(join(dir, GUARD_STAMP), text);
      expect(guardAlive(dir, now.getTime())).toBe(false);
    }
  });

  it('stamps the guard version and reads it only while fresh', () => {
    writeGuardStamp(dir, now, '0.6.0');
    expect(guardVersion(dir, now.getTime() + 1_000)).toBe('0.6.0');
    expect(guardVersion(dir, now.getTime() + 121_000)).toBeNull();
    // A stamp from a guard before 0.6.0 has no version: alive, but no version to read.
    writeFileSync(join(dir, GUARD_STAMP), JSON.stringify({ at: now.toISOString() }));
    expect(guardAlive(dir, now.getTime() + 1_000)).toBe(true);
    expect(guardVersion(dir, now.getTime() + 1_000)).toBeNull();
    rmSync(join(dir, GUARD_STAMP));
    expect(guardVersion(dir, now.getTime())).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('is private to the user', () => {
    writeGuardStamp(dir, now, '0.6.0');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, GUARD_STAMP)).mode & 0o777).toBe(0o600);
  });
});
