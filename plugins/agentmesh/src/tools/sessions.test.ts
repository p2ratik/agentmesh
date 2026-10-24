import { MeshError } from '@agentmesh/common';
import { describe, expect, it, vi } from 'vitest';
import { fakeHub, text } from './fake-hub';
import { callTool } from './registry';

const view = (active: boolean, description: string | null) => ({
  id: 's-aaaaaaaaaaaa',
  active,
  description,
  repo: 'opzami/web',
  branch: 'main',
  owns: [],
});

describe('session tools', () => {
  it('activate without a code asks the hub to send the check and explains the channel flag', async () => {
    const { deps, calls } = fakeHub({ 'session.check': { ok: true } });
    const result = await callTool('activate', {}, deps);
    expect(calls.map((c) => [c.method, c.params])).toEqual([['session.check', {}]]);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Sent a test message to this session.');
    expect(text(result)).toContain(
      'restart it with claude --dangerously-load-development-channels plugin:agentmesh@agentmesh',
    );
    // Claude Desktop can't pass the flag, so the hint must not send its users to a restart alone.
    expect(text(result)).toContain('Claude Desktop cannot pass that flag');
    // The code reaches Claude only through the hub's push, which is what proves pushes work.
    expect(text(result)).not.toContain('Code:');
  });

  // The hub sends the code to the session subject; one sent before the plugin subscribes is lost.
  it('activate waits for the session to listen before asking for a check', async () => {
    const { deps, calls } = fakeHub({ 'session.check': { ok: true } });
    const listening = Promise.withResolvers<void>();
    deps.listening = listening.promise;
    const result = callTool('activate', {}, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    listening.resolve();
    expect(text(await result)).toContain('Sent a test message to this session.');
    expect(calls.map((c) => c.method)).toEqual(['session.check']);
  });

  it('activate asks for the check after 3 s even if the session never listens', async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls } = fakeHub({ 'session.check': { ok: true } });
      deps.listening = new Promise(() => undefined);
      const result = callTool('activate', {}, deps);
      await vi.advanceTimersByTimeAsync(2999);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).isError).toBeUndefined();
      expect(calls.map((c) => c.method)).toEqual(['session.check']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('activate with the code and a description activates through the hub', async () => {
    const { deps, calls } = fakeHub({ 'session.activate': view(true, 'checkout redesign') });
    deps.activation.renewedFrom = 'checkout';
    const args = { code: 'K7Q2ZP', description: 'checkout redesign' };
    const result = await callTool('activate', args, deps);
    expect(calls.map((c) => [c.method, c.params])).toEqual([['session.activate', args]]);
    expect(text(result)).toBe('This session is active on the mesh as “checkout redesign”.');
    expect(deps.activation).toEqual({ lastDescription: 'checkout redesign', renewedFrom: null });
  });

  it('activate needs a description with the code, and reports a code the hub refused', async () => {
    const refused = new MeshError('invalid_request', 'That code is wrong or stale.');
    const { deps, calls } = fakeHub({ 'session.activate': refused });
    const noDescription = await callTool('activate', { code: 'K7Q2ZP' }, deps);
    expect(noDescription.isError).toBe(true);
    expect(text(noDescription)).toMatch(/description/);
    expect(calls).toEqual([]);
    const wrong = await callTool('activate', { code: 'ZZZZZZ', description: 'x' }, deps);
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toMatch(/wrong or stale/);
    expect(deps.activation.lastDescription).toBeNull();
  });

  it('deactivate, describe_session and take map to their RPCs', async () => {
    const { deps, calls } = fakeHub({
      'session.describe': view(true, 'billing v2'),
      'session.deactivate': view(false, 'billing v2'),
      'session.take': { threadId: 'thr-9', previousSession: 's-bbbbbbbbbbbb' },
    });
    await callTool('describe_session', { description: 'billing v2' }, deps);
    expect(deps.activation.lastDescription).toBe('billing v2');
    deps.activation.renewedFrom = 'billing';
    await callTool('deactivate', {}, deps);
    expect(deps.activation).toEqual({ lastDescription: null, renewedFrom: null });
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
