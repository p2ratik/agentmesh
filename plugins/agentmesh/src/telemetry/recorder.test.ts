import { randomUUID } from 'node:crypto';
import { ReportedEvent } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { connectedEvent, Recorder } from './recorder';

const at = '2026-11-06T10:00:00.000Z';
const hook = (unread: number) =>
  ({ kind: 'hook', source: 'hook', session: null, note: 'note_shown', unread }) as const;

describe('Recorder', () => {
  it('keeps the newest 500 and records the gap', () => {
    const recorder = new Recorder({ max: () => 500, on: true, now: () => new Date(at) });
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
    const recorder = new Recorder({ max: () => 3, on: true });
    for (let i = 0; i < 5; i++) recorder.record(hook(i)); // 0 and 1 dropped
    const batch = recorder.take(2); // the gap of 2, then event 2
    recorder.record(hook(5));
    recorder.putBack(batch); // 2, 3, 4, 5: event 2 no longer fits
    const [gap, ...kept] = recorder.take(10);
    expect(gap).toMatchObject({ kind: 'dropped', count: 3, id: batch[0]?.id });
    expect(kept.map((e) => (e.kind === 'hook' ? e.unread : -1))).toEqual([3, 4, 5]);
  });

  it('a pause holds until on(); off is for the whole process', () => {
    const recorder = new Recorder({ max: () => 500, on: true });
    recorder.record(hook(1));
    recorder.pause(); // the hub said observability is off: what it holds is dropped
    recorder.record(hook(2));
    expect(recorder.take(10)).toEqual([]);
    recorder.on(); // a hello that says it is on
    recorder.record(hook(3));
    expect(recorder.take(10)).toMatchObject([{ unread: 3 }]);
    recorder.off(); // a hub without telemetry.report: no hello brings it back
    recorder.on();
    recorder.record(hook(4));
    expect(recorder.take(10)).toEqual([]);
  });

  // A version it wasn't told, or one that isn't a version (a dev build says `dev`), is null, so
  // the session's connected event still validates.
  it.each([
    [undefined, null],
    ['dev', null],
    ['2.1.319', '2.1.319'],
  ])('connected names Claude Code version %s as %s, and validates', (version, expected) => {
    const session = { hub: { sessionId: 's-aaaaaaaaaaaa' }, window: { state: 'none' } };
    const server = { getClientVersion: () => (version ? { name: 'x', version } : undefined) };
    const e = connectedEvent({ ...session, activation: { pull: false } } as never, server);
    expect(e).toMatchObject({ claudeCodeVersion: expected, node: process.versions.node });
    expect(ReportedEvent.safeParse({ ...e, id: randomUUID(), at }).success).toBe(true);
  });

  it('starts off, checking back, until something says observability is on', () => {
    const recorder = new Recorder({ max: () => 500 });
    expect(recorder.paused).toBe(true); // no hello yet
    recorder.record(hook(1));
    recorder.on();
    expect(recorder.take(10)).toEqual([]);
    // Turned off later: what it holds is dropped, not kept for a later hello.
    recorder.record(hook(2));
    recorder.pause();
    recorder.on();
    expect(recorder.take(10)).toEqual([]);
  });
});
