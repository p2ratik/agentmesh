import { describe, expect, it } from 'vitest';
import { Recorder } from './recorder';

const at = '2026-11-06T10:00:00.000Z';
const hook = (unread: number) =>
  ({ kind: 'hook', source: 'hook', session: null, note: 'note_shown', unread }) as const;

describe('Recorder', () => {
  it('keeps the newest 500 and records the gap', () => {
    const recorder = new Recorder({ max: () => 500, enabled: () => true, now: () => new Date(at) });
    for (let i = 0; i < 600; i++) recorder.record(hook(i));
    const [gap, ...kept] = recorder.take(1000);
    expect(gap).toMatchObject({ kind: 'dropped', source: 'plugin', count: 100, at });
    expect(kept).toHaveLength(500);
    expect(kept[0]).toMatchObject({
      unread: 100,
      at,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(kept.at(-1)).toMatchObject({ unread: 599 });
    expect(recorder.take(1000)).toEqual([]);
  });

  it('puts a batch back in front, and counts what no longer fits as dropped', () => {
    const recorder = new Recorder({ max: () => 3, enabled: () => true });
    for (let i = 0; i < 5; i++) recorder.record(hook(i)); // 0 and 1 dropped
    const batch = recorder.take(2); // the gap of 2, then event 2
    recorder.record(hook(5));
    recorder.putBack(batch); // 2, 3, 4, 5: event 2 no longer fits
    const [gap, ...kept] = recorder.take(10);
    expect(gap).toMatchObject({ kind: 'dropped', count: 3, id: batch[0]?.id });
    expect(kept.map((e) => (e.kind === 'hook' ? e.unread : -1))).toEqual([3, 4, 5]);
  });

  it('records nothing when disabled', () => {
    let enabled = false;
    const recorder = new Recorder({ max: () => 500, enabled: () => enabled });
    recorder.record(hook(1));
    enabled = true;
    expect(recorder.take(10)).toEqual([]);
    // Turned off later: what it holds is dropped, not kept for a later hello.
    recorder.record(hook(2));
    enabled = false;
    expect(recorder.take(10)).toEqual([]);
    enabled = true;
    expect(recorder.take(10)).toEqual([]);
  });
});
