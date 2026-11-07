import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@agentmesh/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeHub } from '../tools/fake-hub';
import { Recorder } from './recorder';
import { startShipper } from './shipper';

const tool = (ms: number) =>
  ({ kind: 'tool', source: 'plugin', session: null, tool: 'peers', outcome: 'ok', ms }) as const;

describe("the shipper's last report", () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'am-ship-stop-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(answer: unknown, events: number) {
    const recorder = new Recorder({ max: () => 500, on: true });
    for (let i = 0; i < events; i++) recorder.record(tool(i));
    const { deps, calls } = fakeHub({ 'telemetry.report': answer });
    const stop = startShipper({
      hub: deps.hub,
      recorder,
      dataDir: dir,
      agentId: 'bob-agent',
      pluginDataFolder: true,
      intervalMs: 20_000,
      logger: { info: vi.fn(), debug: vi.fn() } as unknown as Logger,
      relayExpiry: false,
    });
    const sent = () => calls.map((c) => (c.params as { events: unknown[] }).events);
    return { stop, sent };
  }

  it('counts what one report cannot carry in its dropped marker', async () => {
    const { stop, sent } = start({ accepted: 100, dropped: 0 }, 150);
    await stop();
    const [events = []] = sent();
    expect(events).toHaveLength(100);
    expect(events[0]).toMatchObject({ kind: 'dropped', count: 51 });
    expect(events.at(-1)).toMatchObject({ kind: 'tool', ms: 149 });
  });

  it('clears its 100 ms timer when the report answers early', async () => {
    const { stop } = start({ accepted: 2, dropped: 0 }, 2);
    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
