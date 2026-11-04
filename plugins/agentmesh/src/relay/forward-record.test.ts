import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimForward,
  FORWARD_TTL_MS,
  forwardFile,
  readForwards,
  removeForward,
  writeForward,
} from './forward-record';

const HEX = 'a'.repeat(32);
const ID = 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9M';
const FIELDS = { from: 'sagar-agent', threadId: 'thr-12', messageId: ID };
const NAME = `fwd-${HEX}-${ID}.json`;
const now = Date.parse('2026-11-04T10:00:00Z');

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'am-fwd-')), 'data');
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

describe('forward records', () => {
  it('names the file only for a valid hex and message id', () => {
    expect(FORWARD_TTL_MS).toBe(600_000);
    expect(forwardFile(HEX, ID)).toBe(NAME);
    expect(forwardFile('A'.repeat(32), ID)).toBeNull();
    expect(forwardFile(`${HEX}0`, ID)).toBeNull();
    expect(forwardFile(HEX, '../msg')).toBeNull();
  });

  it('reads back an unexpired record for its address only', () => {
    writeForward(dir, HEX, FIELDS, now + FORWARD_TTL_MS);
    expect(readdirSync(dir)).toEqual([NAME]);
    expect(readForwards(dir, HEX, now)).toEqual([{ name: NAME, fields: FIELDS }]);
    expect(readForwards(dir, HEX, now + FORWARD_TTL_MS + 1)).toEqual([]);
    expect(readForwards(dir, 'b'.repeat(32), now)).toEqual([]);
    expect(readForwards(join(dir, 'missing'), HEX, now)).toEqual([]);
  });

  it('refuses a record whose expiry lies further ahead than the TTL', () => {
    writeForward(dir, HEX, FIELDS, now + FORWARD_TTL_MS + 1);
    expect(readForwards(dir, HEX, now)).toEqual([]);
    writeForward(dir, HEX, FIELDS, Number.MAX_SAFE_INTEGER);
    expect(readForwards(dir, HEX, now)).toEqual([]);
  });

  it('skips a record with an edited field, and unreadable files', () => {
    writeForward(dir, HEX, FIELDS, now + 60_000);
    const edit = (over: object) =>
      writeFileSync(join(dir, NAME), JSON.stringify({ ...FIELDS, expiresAt: now + 1, ...over }));
    edit({ from: 'Sagar' });
    expect(readForwards(dir, HEX, now)).toEqual([]);
    // The name and the content must agree on the message.
    edit({ messageId: 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9A' });
    expect(readForwards(dir, HEX, now)).toEqual([]);
    edit({ expiresAt: String(now + 1) });
    expect(readForwards(dir, HEX, now)).toEqual([]);
    for (const text of ['', '{', 'null', '7']) {
      writeFileSync(join(dir, NAME), text);
      expect(readForwards(dir, HEX, now)).toEqual([]);
    }
  });

  it('claims a record once, then it is gone', () => {
    writeForward(dir, HEX, FIELDS, now + 60_000);
    expect(claimForward(dir, NAME)).toBe(true);
    expect(claimForward(dir, NAME)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes a record', () => {
    writeForward(dir, HEX, FIELDS, now + 60_000);
    removeForward(dir, NAME);
    expect(existsSync(join(dir, NAME))).toBe(false);
    removeForward(dir, NAME);
  });

  it.skipIf(process.platform === 'win32')('is private to the user', () => {
    writeForward(dir, HEX, FIELDS, now + 60_000);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, NAME)).mode & 0o777).toBe(0o600);
  });
});
