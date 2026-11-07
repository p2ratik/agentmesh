import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Logger, MeshError } from '@agentmesh/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeHub } from '../tools/fake-hub';
import { Recorder } from './recorder';
import { startShipper } from './shipper';

const BEAT = 20_000;
const tool = (ms: number) =>
  ({ kind: 'tool', source: 'plugin', session: null, tool: 'peers', outcome: 'ok', ms }) as const;
const failed = (sinceReceivedMs: number) =>
  ({
    kind: 'delivery',
    source: 'plugin',
    session: null,
    stage: 'push_failed',
    message: 'msg-01JC0000000000000000000000',
    thread: 'thr-1',
    sinceReceivedMs,
  }) as const;
const deny = {
  id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  at: '2026-11-06T10:00:00.000Z',
  session: null,
  source: 'guard',
  kind: 'guard',
  tool: 'Edit',
  decision: 'deny',
  reason: 'path.outside_worktree',
};
const timeout = () => new MeshError('timeout', 'The mesh hub did not answer in time.');
const sentEvents = (calls: Array<{ params: unknown }>) =>
  calls.map((c) => (c.params as { events: Array<{ id: string }> }).events);

describe('the shipper', () => {
  let dir: string;
  let logger: Logger;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'am-ship-'));
    logger = { info: vi.fn(), debug: vi.fn() } as unknown as Logger;
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A shipper whose hub answers from `answers` and has a session (the hub answered a hello). */
  function start(answers: Record<string, unknown>, events = 0, max = 500) {
    const recorder = new Recorder({ max: () => max, enabled: () => true });
    for (let i = 0; i < events; i++) recorder.record(tool(i));
    const { deps, calls } = fakeHub(answers);
    const hub = Object.assign(deps.hub, { sessionId: 's-aaaaaaaaaaaa' as string | null });
    const stop = startShipper({ hub, recorder, dataDir: dir, intervalMs: BEAT, logger });
    return { recorder, calls, stop, hub };
  }

  it('ships in batches of 100 and drops only what the hub acknowledged', async () => {
    const answers: Record<string, unknown> = { 'telemetry.report': { accepted: 100, dropped: 0 } };
    const { calls, stop } = start(answers, 150);
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(calls.map((c) => c.method)).toEqual(['telemetry.report']);
    expect(calls[0]?.options).toEqual({ timeoutMs: BEAT });
    expect(sentEvents(calls)[0]).toHaveLength(100);
    // The hub took 40 of the next 50 (some over its cap): the other 10 go again.
    answers['telemetry.report'] = { accepted: 30, dropped: 10 };
    await vi.advanceTimersByTimeAsync(BEAT);
    await vi.advanceTimersByTimeAsync(BEAT);
    const [, second, third] = sentEvents(calls);
    expect(second).toHaveLength(50);
    expect(third).toEqual(second?.slice(40));
    await stop();
  });

  it('puts a batch back when the call fails', async () => {
    const answers: Record<string, unknown> = { 'telemetry.report': timeout() };
    const { calls, stop } = start(answers, 3);
    await vi.advanceTimersByTimeAsync(BEAT);
    answers['telemetry.report'] = { accepted: 3, dropped: 0 };
    await vi.advanceTimersByTimeAsync(BEAT);
    await vi.advanceTimersByTimeAsync(BEAT);
    const [failedBatch, retried, ...rest] = sentEvents(calls);
    expect(retried).toEqual(failedBatch);
    expect(rest).toEqual([]);
    expect(logger.debug).toHaveBeenCalledOnce();
    await stop();
  });

  it('keeps the order after a failed send, with newer events behind it', async () => {
    const answers: Record<string, unknown> = {};
    const { recorder, calls, stop } = start(answers, 2);
    const out = Promise.withResolvers<unknown>();
    answers['telemetry.report'] = out.promise;
    await vi.advanceTimersByTimeAsync(BEAT);
    recorder.record(tool(2));
    recorder.record(tool(3));
    out.reject(timeout());
    answers['telemetry.report'] = { accepted: 4, dropped: 0 };
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(sentEvents(calls)[1]).toMatchObject([{ ms: 0 }, { ms: 1 }, { ms: 2 }, { ms: 3 }]);
    await stop();
  });

  it('keeps the dropped gap across a failed send', async () => {
    const answers: Record<string, unknown> = { 'telemetry.report': timeout() };
    const { calls, stop } = start(answers, 5, 3);
    await vi.advanceTimersByTimeAsync(BEAT);
    answers['telemetry.report'] = { accepted: 4, dropped: 0 };
    await vi.advanceTimersByTimeAsync(BEAT);
    const [first, retried] = sentEvents(calls);
    expect(first).toMatchObject([{ kind: 'dropped', count: 2 }, { ms: 2 }, { ms: 3 }, { ms: 4 }]);
    expect(retried).toEqual(first);
    await stop();
  });

  it('never sends two batches at once', async () => {
    const answers: Record<string, unknown> = {};
    const { recorder, calls, stop } = start(answers, 1);
    const out = Promise.withResolvers<unknown>();
    answers['telemetry.report'] = out.promise;
    await vi.advanceTimersByTimeAsync(BEAT);
    recorder.record(tool(1));
    await vi.advanceTimersByTimeAsync(2 * BEAT);
    expect(calls).toHaveLength(1);
    answers['telemetry.report'] = { accepted: 1, dropped: 0 };
    out.resolve({ accepted: 1, dropped: 0 });
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(sentEvents(calls)).toMatchObject([[{ ms: 0 }], [{ ms: 1 }]]);
    await stop();
  });

  it('stops after an unknown-method error, and records nothing more', async () => {
    const answers = {
      'telemetry.report': new MeshError('not_found', 'Unknown method "telemetry.report"'),
    };
    const { recorder, calls, stop } = start(answers, 3);
    await vi.advanceTimersByTimeAsync(BEAT);
    recorder.record(tool(9));
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    expect(calls).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledOnce();
    expect(recorder.take(10)).toEqual([]);
    await stop();
  });

  it("collects and validates the guard's file, counting a bad line as dropped", async () => {
    const lines = [JSON.stringify(deny), '{"kind":"guard","text":"rm -rf"}', 'not json', ''];
    writeFileSync(join(dir, 'events-4242.jsonl'), lines.join('\n'));
    const { calls, stop } = start({ 'telemetry.report': { accepted: 2, dropped: 0 } });
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(sentEvents(calls)).toMatchObject([[{ kind: 'dropped', count: 2 }, deny]]);
    expect(existsSync(join(dir, 'events-4242.jsonl'))).toBe(false);
    await stop();
  });

  it('counts a recorded event that fails validation as dropped', async () => {
    const { recorder, calls, stop } = start({ 'telemetry.report': { accepted: 1, dropped: 0 } });
    recorder.record({ ...tool(1), thread: 'thr-x' });
    recorder.record(tool(2));
    await vi.advanceTimersByTimeAsync(BEAT);
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(sentEvents(calls)).toMatchObject([[{ ms: 2 }], [{ kind: 'dropped', count: 1 }]]);
    await stop();
  });

  // Guard and hook events from before the hub answers survive a hub unreachable at startup.
  it('leaves the files alone until the hub answers a hello', async () => {
    const file = join(dir, 'events-4242.jsonl');
    writeFileSync(file, `${JSON.stringify(deny)}\n`);
    const { hub, calls, stop } = start({ 'telemetry.report': { accepted: 1, dropped: 0 } });
    hub.sessionId = null;
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(existsSync(file)).toBe(true);
    hub.sessionId = 's-aaaaaaaaaaaa';
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(existsSync(file)).toBe(false);
    expect(sentEvents(calls)).toEqual([[deny]]);
    await stop();
  });

  it('sends early after an error-kind event, at most every 2 s', async () => {
    const { recorder, calls, stop } = start({ 'telemetry.report': { accepted: 1, dropped: 0 } });
    recorder.record(failed(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    recorder.record(failed(2));
    await vi.advanceTimersByTimeAsync(1900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    await stop();
  });

  it('re-arms an early send that found another send in flight', async () => {
    const answers: Record<string, unknown> = {};
    const { recorder, calls, stop } = start(answers);
    const out = Promise.withResolvers<unknown>();
    answers['telemetry.report'] = out.promise;
    recorder.record(failed(1));
    await vi.advanceTimersByTimeAsync(0);
    recorder.record(failed(2)); // due at 2 s, while the first send is still out
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(1);
    answers['telemetry.report'] = { accepted: 1, dropped: 0 };
    out.resolve({ accepted: 1, dropped: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    await stop();
  });

  it('stop sends one last report of what is buffered, waiting at most 100 ms', async () => {
    const { calls, stop } = start({ 'telemetry.report': new Promise(() => undefined) }, 2);
    let stopped = false;
    void stop().then(() => {
      stopped = true;
    });
    expect(sentEvents(calls)).toMatchObject([[{ ms: 0 }, { ms: 1 }]]);
    expect(calls[0]?.options).toEqual({ session: 's-aaaaaaaaaaaa', timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(99);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
  });
});
