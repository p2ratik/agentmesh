import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hookOutput, readAll } from './io';

describe('readAll', () => {
  it('reads a 5 MB tool call whole', async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => String(i % 10).repeat(100_000));
    const text = await readAll(Readable.from(chunks), null);
    expect(text.length).toBe(5_000_000);
    expect(text).toBe(chunks.join(''));
  });

  it('keeps a character split across chunks', async () => {
    const euro = Buffer.from('€');
    const parts = [euro.subarray(0, 1), euro.subarray(1)];
    expect(await readAll(Readable.from(parts), null)).toBe('€');
  });

  it('with a cap, resolves what it has when the writer never closes', async () => {
    const stream = new PassThrough();
    stream.write('{"a":');
    expect(await readAll(stream, 50)).toBe('{"a":');
  });

  it('rejects when the stream fails', async () => {
    const stream = new PassThrough();
    const read = readAll(stream, null);
    stream.destroy(new Error('broken pipe'));
    await expect(read).rejects.toThrow('broken pipe');
  });
});

describe('hookOutput', () => {
  it('denies with exit 2 and the reason on stderr', () => {
    expect(hookOutput({ kind: 'deny', reason: 'no' })).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'no',
    });
  });

  it('asks with a PreToolUse permission decision', () => {
    expect(hookOutput({ kind: 'ask', reason: 'why' })).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'why',
        },
      }),
      stderr: '',
    });
  });

  it('says nothing for pass and stamp', () => {
    const quiet = { exitCode: 0, stdout: '', stderr: '' };
    expect(hookOutput({ kind: 'pass' })).toEqual(quiet);
    expect(hookOutput({ kind: 'stamp' })).toEqual(quiet);
  });
});
