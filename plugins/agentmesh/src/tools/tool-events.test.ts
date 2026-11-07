import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import { VERSION } from '@agentmesh/common/version';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { status } from '../inbox/session-inbox.fixture';
import { writeGuardStamp } from '../window/guard-stamp';
import { answerCheck, reactivatePull } from './activation';
import { fakeHub } from './fake-hub';
import { callTool } from './registry';

const SESSION = 's-aaaaaaaaaaaa';
const recorded = (deps: ReturnType<typeof fakeHub>['deps']) => deps.recorder.take(100);
const activations = (deps: ReturnType<typeof fakeHub>['deps']) =>
  recorded(deps).flatMap((e) => (e.kind === 'activation' ? [e] : []));

describe('recording tool calls', () => {
  it('a failing tool records its error code and the thread id, but none of its text arguments', async () => {
    const { deps } = fakeHub({ 'message.send': new MeshError('not_found', 'no such thread') });
    const args = { thread_id: 'thr-7', text: 'the secret plan', pr_url: 'https://x/y' };
    const result = await callTool('reply', args, deps);
    expect(result.isError).toBe(true);
    const [event] = recorded(deps);
    expect(event).toMatchObject({
      kind: 'tool',
      source: 'plugin',
      session: SESSION,
      tool: 'reply',
      outcome: 'not_found',
      thread: 'thr-7',
    });
    expect(JSON.stringify(event)).not.toMatch(/secret|https/);
    expect(Object.keys(event ?? {})).not.toContain('text');
  });

  it('records a crash as internal, with the task id, and a success as ok', async () => {
    const { deps } = fakeHub({ 'task.get': new Error('boom'), 'inbox.peek': {} });
    await callTool('task_get', { task_id: 'task-3' }, deps);
    const [event] = recorded(deps);
    expect(event).toMatchObject({ tool: 'task_get', outcome: 'internal', task: 'task-3' });
  });
});

describe('more tool and status recording', () => {
  it('a successful call records ok', async () => {
    const { deps } = fakeHub({ 'session.deactivate': {} });
    await callTool('deactivate', {}, deps);
    expect(recorded(deps)).toMatchObject([
      { kind: 'activation', phase: 'deactivated' },
      { kind: 'tool', tool: 'deactivate', outcome: 'ok' },
    ]);
  });

  it('a status item that rides out in a tool result records delivery pushed', async () => {
    const { deps } = fakeHub({ 'session.deactivate': {} });
    const id = 'msg-00000000000000000000000001';
    deps.fyi.add([status(id, 'thr-4')]);
    await callTool('deactivate', {}, deps);
    const delivery = recorded(deps).filter((e) => e.kind === 'delivery');
    expect(delivery).toMatchObject([{ message: id, thread: 'thr-4', stage: 'pushed' }]);
  });
});

describe('recording activation', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'am-act-ev-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const window = (dir: string) =>
    ({ state: 'verified', policy: null, setUp: true, dataDir: dir, folder: '.' }) as const;

  it('a refused window activation records activation refused with activation.guard_down', async () => {
    const { deps } = fakeHub({});
    deps.window = window(dataDir); // no guard stamp
    await callTool('activate', {}, deps);
    const [event] = activations(deps);
    expect(event).toMatchObject({
      phase: 'refused',
      mode: 'push',
      reason: 'activation.guard_down',
    });
  });

  it('records the two activate refusals that had no code', async () => {
    const { deps } = fakeHub({});
    await callTool('activate', { pull: true }, deps);
    deps.window = window(dataDir);
    writeGuardStamp(dataDir, new Date(), VERSION);
    await callTool('activate', { pull: true, description: 'x' }, deps);
    expect(activations(deps).map((e) => e.reason)).toEqual([
      'activation.no_description',
      'activation.pull_in_window',
    ]);
  });

  it('records check_sent, activated and deactivated', async () => {
    const view = {
      id: SESSION,
      active: true,
      description: 'x',
      repo: null,
      branch: null,
      owns: [],
    };
    const { deps } = fakeHub({
      'session.check': { ok: true },
      'session.activate': view,
      'session.deactivate': {},
    });
    await callTool('activate', {}, deps);
    await callTool('activate', { code: 'K7Q2ZP', description: 'x' }, deps);
    await callTool('deactivate', {}, deps);
    expect(activations(deps).map((e) => e.phase)).toEqual([
      'check_sent',
      'activated',
      'deactivated',
    ]);
  });

  it('a wrong code is refused with activation.wrong_code', async () => {
    const wrong = new MeshError('invalid_request', 'That code is wrong or stale.');
    const { deps } = fakeHub({ 'session.activate': wrong });
    await callTool('activate', { code: 'NOPE', description: 'x' }, deps);
    expect(activations(deps)[0]).toMatchObject({
      phase: 'refused',
      reason: 'activation.wrong_code',
    });
  });

  it('check errors are failed with hub_error, wrong_code only for a refused code', async () => {
    const bad = new MeshError('invalid_request', 'nope');
    const { deps } = fakeHub({ 'session.check': bad });
    await callTool('activate', {}, deps);
    expect(activations(deps)).toMatchObject([{ phase: 'failed', reason: 'activation.hub_error' }]);
  });

  it('a deactivated pull session records mode pull', async () => {
    const { deps } = fakeHub({ 'session.deactivate': {} });
    deps.activation.pull = true;
    await callTool('deactivate', {}, deps);
    expect(activations(deps)).toMatchObject([{ phase: 'deactivated', mode: 'pull' }]);
  });

  it('a pull renewal records renewed, or failed with hub_error', async () => {
    const view = { id: SESSION, active: true, description: 'x' };
    const { deps } = fakeHub({ 'session.activate': view });
    deps.activation.lastDescription = 'x';
    const base = {
      hub: deps.hub as never,
      activation: deps.activation,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      refresh: async () => undefined,
      recorder: deps.recorder,
    };
    await reactivatePull(base);
    const boom = fakeHub({ 'session.activate': new Error('down') });
    await reactivatePull({ ...base, hub: boom.deps.hub as never, recorder: deps.recorder });
    expect(activations(deps).map((e) => [e.phase, e.mode, e.reason])).toEqual([
      ['renewed', 'pull', undefined],
      ['failed', 'pull', 'activation.hub_error'],
    ]);
  });

  it('a renewal that falls back records each reason', async () => {
    const live = { id: 's-other', meshWindow: true, liveness: 'live' } as never;
    const cases: Array<[Record<string, unknown>, object, never[], string]> = [
      [{}, { state: 'marked' }, [], 'marker.unverified'],
      [{}, window(dataDir), [live], 'activation.another_window_live'],
      [{ 'session.activate': new Error('down') }, {}, [], 'activation.hub_error'],
    ];
    for (const [answers, win, others, reason] of cases) {
      const { deps } = fakeHub(answers);
      deps.activation.renewedFrom = 'x';
      deps.activation.lastDescription = 'x';
      deps.activation.guardVersion = '0.6.0';
      await answerCheck('K7Q2ZP', {
        hub: deps.hub as never,
        activation: deps.activation,
        window: { ...deps.window, ...win } as never,
        logger: { info: vi.fn(), warn: vi.fn() } as never,
        push: async () => undefined,
        refresh: async () => undefined,
        agentSessions: () => others,
        recorder: deps.recorder,
      });
      expect(activations(deps)).toMatchObject([{ phase: 'renewal_fallback', reason }]);
    }
  });

  it('a renewal records renewed; one that falls back records renewal_fallback with its reason', async () => {
    const view = { id: SESSION, active: true, description: 'x' };
    const { deps } = fakeHub({ 'session.activate': view });
    deps.activation.renewedFrom = 'x';
    deps.activation.lastDescription = 'x';
    const base = {
      hub: deps.hub as never,
      activation: deps.activation,
      window: deps.window,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      push: async () => undefined,
      refresh: async () => undefined,
      agentSessions: () => [],
      recorder: deps.recorder,
    };
    await answerCheck('K7Q2ZP', base);
    deps.activation.renewedFrom = 'x';
    await answerCheck('K7Q2ZP', { ...base, window: window(dataDir) });
    expect(activations(deps).map((e) => [e.phase, e.reason])).toEqual([
      ['renewed', undefined],
      ['renewal_fallback', 'activation.no_proof'],
    ]);
  });
});
