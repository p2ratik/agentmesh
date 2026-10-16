import { MeshError } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import type { HubClient } from '../hub';
import { callTool, listTools } from './registry';
import type { ToolDeps } from './types';

/** A HubClient stand-in that records calls and answers from a table. */
function fakeHub(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
  const hub = {
    call: async (method: string, params: unknown, options: unknown) => {
      calls.push({ method, params, options });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as HubClient;
  const deps: ToolDeps = { hub, agentId: 'alice-agent' };
  return { deps, calls };
}

const task = {
  id: 'task-3',
  title: 'Fix login',
  state: 'in_progress',
  assignee: 'alice-agent',
  availableActions: ['block', 'submit'],
};

describe('tool registry', () => {
  it('lists every tool with an object JSON schema', () => {
    const tools = listTools();
    expect(tools.length).toBe(21);
    const ask = tools.find((t) => t.name === 'ask');
    expect(ask?.inputSchema.type).toBe('object');
    expect(ask?.inputSchema).not.toHaveProperty('$schema');
    expect(ask?.inputSchema.required).toEqual(['to', 'text']);
  });

  it('maps snake_case arguments to RPC params with an idempotency key', async () => {
    const { deps, calls } = fakeHub({
      'message.send': {
        threadId: 'thr-2',
        messageId: 'msg-1',
        deliveredTo: ['bob-agent'],
        held: false,
      },
    });
    const result = await callTool(
      'ask',
      { to: 'bob-agent', text: 'hi', parent_thread_id: 'thr-1' },
      deps,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('thr-2');
    expect(calls[0]?.params).toEqual({
      kind: 'ask',
      to: ['bob-agent'],
      body: 'hi',
      parentThreadId: 'thr-1',
    });
    expect(calls[0]?.options).toEqual({ idempotencyKey: expect.any(String) });
  });

  it('maps task actions and reports next steps', async () => {
    const { deps, calls } = fakeHub({ 'task.act': task });
    const result = await callTool(
      'task_act',
      { task_id: 'task-3', action: 'submit', pr_url: 'https://x/pr/1' },
      deps,
    );
    expect(calls[0]?.params).toEqual({
      taskId: 'task-3',
      action: 'submit',
      prUrl: 'https://x/pr/1',
    });
    expect(result.content[0]?.text).toContain('Next for you: block, submit');
  });

  it('converts plan drafts to camelCase', async () => {
    const { deps, calls } = fakeHub({
      'plan.submit': { id: 'plan-1', state: 'materialized', taskIds: ['task-1'] },
    });
    await callTool(
      'plan_submit',
      {
        plan_id: 'plan-1',
        summary: 's',
        tasks: [{ key: 'a', title: 'Do a', depends_on: [], done_when: 'tests pass' }],
      },
      deps,
    );
    expect(calls[0]?.params).toMatchObject({
      tasks: [{ key: 'a', title: 'Do a', description: '', dependsOn: [], doneWhen: 'tests pass' }],
    });
  });

  it('turns bad arguments, hub errors and missing setup into readable errors', async () => {
    const { deps } = fakeHub({ 'task.get': new MeshError('not_found', 'Task task-9 not found') });
    expect((await callTool('ask', { text: 'no recipient' }, deps)).content[0]?.text).toMatch(
      /Invalid arguments.*\n.*to/,
    );
    const notFound = await callTool('task_get', { task_id: 'task-9' }, deps);
    expect(notFound).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'not_found: Task task-9 not found' }],
    });
    const unconfigured = await callTool('peers', {}, { problems: ['agent_id is not set'] });
    expect(unconfigured.content[0]?.text).toContain('agent_id is not set');
    expect((await callTool('nope', {}, deps)).isError).toBe(true);
  });
});
