import { MeshError } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import type { HubClient } from '../hub';
import { fakeHub, text } from './fake-hub';
import { callTool, listTools } from './registry';

const task = {
  id: 'task-3',
  title: 'Fix login',
  state: 'in_progress',
  assignee: 'alice-agent',
  availableActions: ['block', 'submit'],
};

const sent = { threadId: 'thr-2', messageId: 'msg-1', deliveredTo: ['bob-agent'], held: false };

describe('tool registry', () => {
  it('lists every tool with an object JSON schema', () => {
    const tools = listTools();
    expect(tools.length).toBe(25);
    const ask = tools.find((t) => t.name === 'ask');
    expect(ask?.inputSchema.type).toBe('object');
    expect(ask?.inputSchema).not.toHaveProperty('$schema');
    expect(ask?.inputSchema.required).toEqual(['to', 'text']);
  });

  it('maps snake_case arguments to RPC params with an idempotency key', async () => {
    const { deps, calls } = fakeHub({ 'message.send': sent });
    const result = await callTool(
      'ask',
      { to: 'bob-agent', text: 'hi', parent_thread_id: 'thr-1' },
      deps,
    );
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('thr-2');
    expect(calls[0]?.params).toEqual({
      kind: 'ask',
      to: ['bob-agent'],
      body: 'hi',
      parentThreadId: 'thr-1',
    });
    expect(calls[0]?.options).toEqual({ idempotencyKey: expect.any(String) });
  });

  it('ask passes to_session and repo', async () => {
    const { deps, calls } = fakeHub({ 'message.send': sent });
    await callTool(
      'ask',
      { to: 'bob-agent', text: 'hi', to_session: 's-bbbbbbbbbbbb', repo: 'opzami/web' },
      deps,
    );
    expect(calls[0]?.params).toMatchObject({ toSession: 's-bbbbbbbbbbbb', repo: 'opzami/web' });
  });

  it('peers prints active sessions', async () => {
    const bob = {
      id: 'bob-agent',
      kind: 'agent',
      displayName: "Bob's Claude",
      owner: 'bob',
      status: 'online',
      statusNote: null,
      lastSeen: null,
      repo: null,
      branch: null,
      skills: [],
      areas: [],
      activeTasks: 1,
      sessions: [
        {
          id: 's-bbbbbbbbbbbb',
          description: 'checkout redesign',
          repo: 'opzami/web',
          branch: 'agent/bob/task-7-checkout',
          activeSince: '2026-10-21T09:00:00.000Z',
          tasks: ['task-7'],
        },
        {
          id: 's-cccccccccccc',
          description: 'reading docs',
          repo: null,
          branch: null,
          activeSince: '2026-10-21T10:00:00.000Z',
          tasks: [],
        },
      ],
    };
    const { deps } = fakeHub({ 'peers.list': { peers: [bob] } });
    const lines = text(await callTool('peers', {}, deps)).split('\n');
    expect(lines[0]).toMatch(/^- bob-agent /);
    expect(lines.slice(1)).toEqual([
      '    · s-bbbbbbbbbbbb — checkout redesign (opzami/web@agent/bob/task-7-checkout) owns task-7',
      '    · s-cccccccccccc — reading docs',
    ]);
  });

  it('tool results end with hub notes', async () => {
    const note = 'thr-2 belongs to your session s-bbbbbbbbbbbb (“billing”); its messages go there.';
    const { deps } = fakeHub({ 'message.send': sent }, { 'message.send': [note] });
    const result = await callTool('reply', { thread_id: 'thr-2', text: 'on it' }, deps);
    expect(result.content).toHaveLength(2);
    expect(text(result, 1)).toBe(note);
    const { deps: quiet } = fakeHub({ 'message.send': sent });
    expect(
      (await callTool('reply', { thread_id: 'thr-2', text: 'ok' }, quiet)).content,
    ).toHaveLength(1);
  });

  it('overlapping tool calls each get only their own hub notes', async () => {
    const release: Array<() => void> = [];
    const hub = {
      call: (_method: string, params: { body: string }, _options: unknown, sink?: string[]) =>
        new Promise((resolve) => {
          release.push(() => {
            sink?.push(`note for ${params.body}`);
            resolve(sent);
          });
        }),
    } as unknown as HubClient;
    const { deps } = fakeHub({});
    const scoped = { ...deps, hub };
    const first = callTool('reply', { thread_id: 'thr-1', text: 'one' }, scoped);
    const second = callTool('reply', { thread_id: 'thr-2', text: 'two' }, scoped);
    expect(release).toHaveLength(2);
    for (const answer of release.reverse()) answer();
    expect(text(await first, 1)).toBe('note for one');
    expect(text(await second, 1)).toBe('note for two');
    expect((await first).content).toHaveLength(2);
    expect((await second).content).toHaveLength(2);
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
    expect(text(result)).toContain('Next for you: block, submit');
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
    expect(text(await callTool('ask', { text: 'no recipient' }, deps))).toMatch(
      /Invalid arguments.*\n.*to/,
    );
    const notFound = await callTool('task_get', { task_id: 'task-9' }, deps);
    expect(notFound).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'not_found: Task task-9 not found' }],
    });
    const unconfigured = await callTool('peers', {}, { problems: ['agent_id is not set'] });
    expect(text(unconfigured)).toContain('agent_id is not set');
    expect((await callTool('nope', {}, deps)).isError).toBe(true);
  });
});
