import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import { VERSION } from '@agentmesh/common/version';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeGuardStamp } from '../window/guard-stamp';
import { answerCheck } from './activation';
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
