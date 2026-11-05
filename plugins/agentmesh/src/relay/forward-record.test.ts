import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
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
const FIELDS = { from: 'alice-agent', threadId: 'thr-12', messageId: ID };
const NAME = `fwd-${HEX}-${ID}.json`;
const now = Date.parse('2026-11-04T10:00:00Z');

// Real threads racing on real files: each loads this module through tsx, then claims the round's
// record the moment the main thread raises `go` to that round.
const TSX = createRequire(import.meta.url).resolve('tsx/esm/api');
const MODULE = new URL('./forward-record.ts', import.meta.url).href;
const RACER = `
const { parentPort, workerData: d } = require('node:worker_threads');
const { join } = require('node:path');
(async () => {
  const { claimForward } = await require(d.tsx).tsImport(d.mod, d.mod);
  const go = new Int32Array(d.go);
  parentPort.postMessage('ready');
  for (let r = 1; r <= d.rounds; r++) {
    for (let v = Atomics.load(go, 0); v < r; v = Atomics.load(go, 0)) Atomics.wait(go, 0, v);
    parentPort.postMessage(claimForward(join(d.dir, String(r)), d.name));
  }
})();`;

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
    edit({ from: 'Alice' });
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

  it('claims a record once, then it is gone and its marker blocks a later claim', () => {
    writeForward(dir, HEX, FIELDS, now + 60_000);
    expect(claimForward(dir, NAME)).toBe(true);
    expect(claimForward(dir, NAME)).toBe(false);
    expect(readdirSync(dir)).toEqual([`${NAME}.claimed`]);
    expect(readForwards(dir, HEX, now)).toEqual([]);
    // Written again (or never removed), the record still can't be claimed past its marker.
    writeForward(dir, HEX, FIELDS, now + 60_000);
    expect(readForwards(dir, HEX, now)).toHaveLength(1);
    expect(claimForward(dir, NAME)).toBe(false);
  });

  it("can't claim a record the window removed after a guard read it", () => {
    writeForward(dir, HEX, FIELDS, now + 60_000);
    expect(readForwards(dir, HEX, now)).toHaveLength(1);
    removeForward(dir, NAME);
    expect(claimForward(dir, NAME)).toBe(false);
  });

  it('lets exactly one of many threads claim a record', async () => {
    const [rounds, threads] = [30, 8];
    for (let r = 1; r <= rounds; r++) writeForward(join(dir, `${r}`), HEX, FIELDS, now + 60_000);
    const go = new Int32Array(new SharedArrayBuffer(4));
    const workerData = { tsx: TSX, mod: MODULE, dir, name: NAME, rounds, go: go.buffer };
    const workers = Array.from(
      { length: threads },
      () => new Worker(RACER, { eval: true, workerData }),
    );
    try {
      await Promise.all(workers.map((w) => once(w, 'message')));
      const winners: number[] = [];
      for (let r = 1; r <= rounds; r++) {
        const claims = workers.map((w) => once(w, 'message').then(([won]) => won as boolean));
        Atomics.store(go, 0, r);
        Atomics.notify(go, 0);
        winners.push((await Promise.all(claims)).filter(Boolean).length);
      }
      expect(winners).toEqual(Array(rounds).fill(1));
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
    }
  }, 30_000);

  it('prunes claim markers older than the TTL when it writes, and nothing else', () => {
    mkdirSync(dir);
    const old = (Date.now() - FORWARD_TTL_MS - 60_000) / 1000;
    const stale = `fwd-${'b'.repeat(32)}-${ID}.json.claimed`;
    // Only the window's own stale markers go; the folder holds other files too.
    const kept = [`${NAME}.claimed`, 'cc-1.json', 'other.claimed'];
    for (const f of [stale, ...kept]) writeFileSync(join(dir, f), '');
    for (const f of [stale, 'cc-1.json', 'other.claimed']) utimesSync(join(dir, f), old, old);
    writeForward(dir, 'c'.repeat(32), FIELDS, now + 60_000);
    expect(readdirSync(dir).sort()).toEqual([`fwd-${'c'.repeat(32)}-${ID}.json`, ...kept].sort());
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
