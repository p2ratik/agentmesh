import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, collectEventFiles, MAX_EVENTS_FILE_BYTES } from './events-file';

describe('the events file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'am-events-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stops appending at 256 KB', () => {
    const file = join(dir, `events-${process.pid}.jsonl`);
    appendEvent(dir, { kind: 'hook', note: 'error' });
    expect(collectEventFiles(dir)).toEqual([{ kind: 'hook', note: 'error' }]);
    expect(readdirSync(dir)).toEqual([]);

    expect(MAX_EVENTS_FILE_BYTES).toBe(256 * 1024);
    writeFileSync(file, 'x'.repeat(MAX_EVENTS_FILE_BYTES));
    appendEvent(dir, { kind: 'hook', note: 'error' });
    expect(statSync(file).size).toBe(MAX_EVENTS_FILE_BYTES);
  });

  it('never throws, even when the folder cannot be written', () => {
    const notADir = join(dir, 'file');
    writeFileSync(notADir, '');
    expect(() => appendEvent(notADir, { kind: 'hook' })).not.toThrow();
    expect(collectEventFiles(join(dir, 'missing'))).toEqual([]);
  });
});
