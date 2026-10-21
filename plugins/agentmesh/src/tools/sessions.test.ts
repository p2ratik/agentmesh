import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelEvent } from '../inbox/render';
import { fakeHub, text } from './fake-hub';
import { callTool } from './registry';
import type { ToolDeps } from './types';

const view = (active: boolean, description: string | null) => ({
  id: 's-aaaaaaaaaaaa',
  active,
  description,
  repo: 'opzami/web',
  branch: 'main',
  owns: [],
});

/** Starts activation and returns the code from the pushed check. */
async function pushedCode(deps: ToolDeps, pushed: ChannelEvent[]): Promise<string> {
  await callTool('activate', {}, deps);
  const code = /Code: ([A-Z2-9]{6})\./.exec(pushed.at(-1)?.content ?? '')?.[1];
  if (!code) throw new Error('no code pushed');
  return code;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('session tools', () => {
  it('activate without a code pushes a check and explains the channel flag', async () => {
    const { deps, calls, pushed } = fakeHub({});
    const result = await callTool('activate', {}, deps);
    expect(pushed).toHaveLength(1);
    const code = /Code: ([A-Z2-9]{6})\./.exec(pushed[0]?.content ?? '')?.[1] ?? '';
    expect(pushed[0]).toEqual({
      content: `AgentMesh activation check. Code: ${code}. To finish, call activate(code: "${code}", description: "<one line: what this session is working on>").`,
      meta: { kind: 'system', from: 'agentmesh' },
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain(
      'restart it with claude --dangerously-load-development-channels plugin:agentmesh@agentmesh',
    );
    // The code reaches Claude only through the push, which is what proves pushes work.
    expect(text(result)).not.toContain(code);
    expect(calls).toEqual([]);
  });

  it('activate with the pushed code and a description activates the session', async () => {
    const { deps, calls, pushed } = fakeHub({
      'session.activate': view(true, 'checkout redesign'),
    });
    const code = await pushedCode(deps, pushed);
    const result = await callTool('activate', { code, description: 'checkout redesign' }, deps);
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ['session.activate', { description: 'checkout redesign' }],
    ]);
    expect(text(result)).toBe('This session is active on the mesh as “checkout redesign”.');
    expect(deps.activation.lastDescription).toBe('checkout redesign');
  });

  it('activate refuses a wrong code', async () => {
    vi.useFakeTimers();
    const { deps, calls, pushed } = fakeHub({ 'session.activate': view(true, 'x') });
    const replaced = await pushedCode(deps, pushed);
    const code = await pushedCode(deps, pushed);
    const description = 'checkout redesign';
    for (const wrong of ['ZZZZZZ', replaced]) {
      const result = await callTool('activate', { code: wrong, description }, deps);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/wrong or stale/);
    }
    const noDescription = await callTool('activate', { code }, deps);
    expect(noDescription.isError).toBe(true);
    expect(text(noDescription)).toMatch(/description/);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect((await callTool('activate', { code, description }, deps)).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('deactivate, describe_session and take map to their RPCs', async () => {
    const { deps, calls } = fakeHub({
      'session.describe': view(true, 'billing v2'),
      'session.deactivate': view(false, 'billing v2'),
      'session.take': { threadId: 'thr-9', previousSession: 's-bbbbbbbbbbbb' },
    });
    await callTool('describe_session', { description: 'billing v2' }, deps);
    expect(deps.activation.lastDescription).toBe('billing v2');
    await callTool('deactivate', {}, deps);
    expect(deps.activation.lastDescription).toBeNull();
    const took = await callTool('take', { task_id: 'task-9' }, deps);
    expect(text(took)).toContain('thr-9');
    await callTool('take', { thread_id: 'thr-9' }, deps);
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ['session.describe', { description: 'billing v2' }],
      ['session.deactivate', {}],
      ['session.take', { taskId: 'task-9' }],
      ['session.take', { threadId: 'thr-9' }],
    ]);
    const both = await callTool('take', { task_id: 'task-9', thread_id: 'thr-9' }, deps);
    expect(both.isError).toBe(true);
  });

  it('describe_session on an inactive session does not count as active', async () => {
    const { deps } = fakeHub({ 'session.describe': view(false, 'idle') });
    await callTool('describe_session', { description: 'idle' }, deps);
    expect(deps.activation.lastDescription).toBeNull();
  });
});
