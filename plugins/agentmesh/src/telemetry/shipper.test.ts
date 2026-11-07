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

  function start(answers: Record<string, unknown>, events = 0) {
    const recorder = new Recorder({ max: () => 500, enabled: () => true });
    for (let i = 0; i < events; i++) recorder.record(tool(i));
    const { deps, calls } = fakeHub(answers);
    const stop = startShipper({ hub: deps.hub, recorder, dataDir: dir, intervalMs: BEAT, logger });
    return { recorder, calls, stop };
  }

  it('ships in batches of 100 and drops only what the hub acknowledged', async () => {
    const answers: Record<string, unknown> = { 'telemetry.report': { accepted: 100, dropped: 0 } };
    const { calls, stop } = start(answers, 150);
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(calls.map((c) => c.method)).toEqual(['telemetry.report']);
    expect(sentEvents(calls)[0]).toHaveLength(100);
    // The hub took 40 of the next 50 (some over its cap): the other 10 go again.
    answers['telemetry.report'] = { accepted: 30, dropped: 10 };
    await vi.advanceTimersByTimeAsync(BEAT);
    await vi.advanceTimersByTimeAsync(BEAT);
    const [, second, third] = sentEvents(calls);
    expect(second).toHaveLength(50);
    expect(third).toEqual(second?.slice(40));
    stop();
  });

  it('puts a batch back when the call fails', async () => {
    const answers: Record<string, unknown> = {
      'telemetry.report': new MeshError('unavailable', 'The mesh hub is not reachable right now.'),
    };
    const { calls, stop } = start(answers, 3);
    await vi.advanceTimersByTimeAsync(BEAT);
    answers['telemetry.report'] = { accepted: 3, dropped: 0 };
    await vi.advanceTimersByTimeAsync(BEAT);
    await vi.advanceTimersByTimeAsync(BEAT);
    const [failed, retried, ...rest] = sentEvents(calls);
    expect(retried).toEqual(failed);
    expect(rest).toEqual([]);
    expect(logger.debug).toHaveBeenCalledOnce();
    stop();
  });

  it('stops after an unknown-method error', async () => {
    const answers = {
      'telemetry.report': new MeshError('not_found', 'Unknown method "telemetry.report"'),
    };
    const { recorder, calls, stop } = start(answers, 3);
    await vi.advanceTimersByTimeAsync(BEAT);
    recorder.record(tool(9));
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    expect(calls).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledOnce();
    stop();
  });

  it("collects and validates the guard's file, dropping a bad line", async () => {
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
    const lines = [JSON.stringify(deny), '{"kind":"guard","text":"rm -rf"}', 'not json', ''];
    writeFileSync(join(dir, 'events-4242.jsonl'), lines.join('\n'));
    const { calls, stop } = start({ 'telemetry.report': { accepted: 1, dropped: 0 } });
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(sentEvents(calls)).toEqual([[deny]]);
    expect(existsSync(join(dir, 'events-4242.jsonl'))).toBe(false);
    stop();
  });

  it('sends early after an error-kind event, at most every 2 s', async () => {
    const { recorder, calls, stop } = start({ 'telemetry.report': { accepted: 1, dropped: 0 } });
    const delivery = {
      kind: 'delivery',
      source: 'plugin',
      session: null,
      stage: 'push_failed',
      message: 'msg-01JC0000000000000000000000',
      thread: 'thr-1',
    } as const;
    recorder.record({ ...delivery, sinceReceivedMs: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    recorder.record({ ...delivery, sinceReceivedMs: 2 });
    await vi.advanceTimersByTimeAsync(1900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    stop();
  });
});
